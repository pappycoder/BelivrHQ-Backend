import { readOnlyPermission } from '../billing/subscription-access';
import { subscriptionError } from '../billing/plan-errors';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { FormsService } from '../forms/forms.service';
import { FormFieldDto } from '../forms/dto/form-field.dto';
import { CreateMemberDto } from '../members/dto/create-member.dto';
import { UpdateMemberDto } from '../members/dto/update-member.dto';
import { CreateVisitorDto } from '../visitors/dto/create-visitor.dto';
import { UpdateVisitorDto } from '../visitors/dto/update-visitor.dto';
import { OfflineMutationDto } from './dto/offline.dto';

type Viewer = NonNullable<AuthenticatedRequest['profile']>;
export interface OfflineAck {
  mutationId: string;
  status: 'accepted' | 'conflict' | 'rejected' | 'retry';
  message?: string;
  version?: string;
}

/** Stable content hash: a mutation ID can never be rebound to another payload. */
export function offlineHash(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

@Injectable()
export class OfflineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly forms: FormsService,
  ) {}

  private scope(viewer: Viewer, branchId: string) {
    if (!viewer?.church_id || !viewer.permissions)
      throw new ForbiddenException('Verified offline scope required');
    if (!viewer.permissions.includes('offline:read'))
      throw new ForbiddenException('Offline workspace access is not permitted');
    if (!viewer.is_admin_hq && (!viewer.branch_id || branchId !== viewer.branch_id))
      throw new ForbiddenException('Offline access is limited to your branch');
    return { church_id: viewer.church_id, branch_id: branchId };
  }

  private can(viewer: Viewer, permission: string) {
    return viewer.permissions?.includes(permission) === true;
  }

  async snapshot(viewer: Viewer, branchId: string) {
    const where = this.scope(viewer, branchId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, church_id: viewer.church_id, archived_at: null },
      select: { id: true, name: true },
    });
    if (!branch) throw new ForbiddenException('Branch is unavailable');
    // Bounded, complete snapshots. Reject instead of silently dropping records.
    const contact = {
      id: true,
      branch_id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      notes: true,
      updated_at: true,
    } as const;
    const members = this.can(viewer, 'members:all:read')
      ? await this.prisma.member.findMany({
          where: { ...where, archived_at: null },
          select: contact,
          orderBy: { id: 'asc' },
          take: 2001,
        })
      : [];
    const visitors = this.can(viewer, 'visitors:list:read')
      ? await this.prisma.visitor.findMany({
          where: { ...where, archived_at: null, deleted_at: null },
          select: contact,
          orderBy: { id: 'asc' },
          take: 2001,
        })
      : [];
    const forms = this.can(viewer, 'forms:list:read')
      ? await this.prisma.form.findMany({
          where: { ...where, archived_at: null, status: 'published', is_template: false },
          select: { id: true, branch_id: true, title: true, fields: true, updated_at: true },
          orderBy: { id: 'asc' },
          take: 501,
        })
      : [];
    if (members.length > 2000 || visitors.length > 2000 || forms.length > 500)
      throw new BadRequestException('This branch exceeds the offline workspace limit');
    return {
      profileId: viewer.id,
      churchId: viewer.church_id,
      branchId,
      branchName: branch.name,
      permissions: viewer.subscriptionReadOnly
        ? (viewer.permissions ?? []).filter(readOnlyPermission)
        : viewer.permissions,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(
        Math.min(
          Date.now() + 7 * 86400000,
          viewer.subscriptionPaidUntil ? Date.parse(viewer.subscriptionPaidUntil) : Infinity,
        ),
      ).toISOString(),
      records: { member: members, visitor: visitors, form: forms },
    };
  }

  async push(
    viewer: Viewer,
    userId: string,
    mutations: OfflineMutationDto[],
  ): Promise<OfflineAck[]> {
    const results: OfflineAck[] = [];
    for (const mutation of mutations) {
      try {
        const where = this.scope(viewer, mutation.branchId);
        const permission =
          mutation.entity === 'submission'
            ? 'forms:list:read'
            : `${mutation.entity === 'member' ? 'members' : 'visitors'}:${mutation.action === 'create' ? 'new:create' : mutation.entity === 'member' ? 'all:update' : 'list:update'}`;
        if (!this.can(viewer, permission))
          throw new ForbiddenException(`Missing permission: ${permission}`);
        if (mutation.entity === 'submission' && (mutation.action !== 'create' || !mutation.formId))
          throw new BadRequestException('Only new form submissions can be synced');
        const hash = offlineHash(mutation);
        const result = await this.prisma.$transaction(async (tx) => {
          // Serializes replays across server instances; the receipt and effect commit together.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${viewer.church_id}:${viewer.id}:${mutation.mutationId}`}, 0))`;
          const receipt = await tx.offlineReceipt.findUnique({
            where: {
              church_id_profile_id_mutation_id: {
                church_id: viewer.church_id,
                profile_id: viewer.id,
                mutation_id: mutation.mutationId,
              },
            },
          });
          if (receipt) {
            if (receipt.payload_hash !== hash)
              throw new BadRequestException('Mutation ID was reused with different content');
            return receipt.result as unknown as OfflineAck;
          }
          const branch = await tx.branch.findFirst({
            where: { id: mutation.branchId, church_id: viewer.church_id, archived_at: null },
          });
          if (!branch) throw new ForbiddenException('Branch is unavailable');
          let ack: OfflineAck;
          try {
            const version =
              mutation.entity === 'submission'
                ? await this.submission(tx, where, mutation, userId)
                : await this.person(tx, where, mutation);
            ack = { mutationId: mutation.mutationId, status: 'accepted', version };
          } catch (error) {
            if (!(error instanceof HttpException)) throw error;
            ack = {
              mutationId: mutation.mutationId,
              status: error instanceof ConflictException ? 'conflict' : 'rejected',
              message: error.message,
            };
          }
          await tx.offlineReceipt.create({
            data: {
              church_id: viewer.church_id,
              profile_id: viewer.id,
              mutation_id: mutation.mutationId,
              payload_hash: hash,
              result: ack as unknown as Prisma.InputJsonValue,
            },
          });
          if (ack.status === 'accepted')
            await tx.auditLog.create({
              data: {
                church_id: viewer.church_id,
                user_id: userId,
                entity: mutation.entity === 'submission' ? 'form_submission' : mutation.entity,
                entity_id: mutation.entityId,
                action: mutation.action.toUpperCase(),
                new_values: mutation.data as Prisma.InputJsonValue,
              },
            });
          return ack;
        });
        results.push(result);
      } catch (error) {
        // Infrastructure failures remain retryable; validation/authorization never auto-retry.
        results.push({
          mutationId: mutation.mutationId,
          status: subscriptionError(error)
            ? 'rejected'
            : error instanceof ConflictException
              ? 'conflict'
              : error instanceof HttpException
                ? 'rejected'
                : 'retry',
          message:
            subscriptionError(error)?.message ??
            (error instanceof HttpException ? error.message : 'Unable to sync now. Try again.'),
        });
      }
    }
    return results;
  }

  private async person(
    tx: Prisma.TransactionClient,
    scope: { church_id: string; branch_id: string },
    mutation: OfflineMutationDto,
  ) {
    const isMember = mutation.entity === 'member';
    const dto = isMember
      ? mutation.action === 'create'
        ? CreateMemberDto
        : UpdateMemberDto
      : mutation.action === 'create'
        ? CreateVisitorDto
        : UpdateVisitorDto;
    const input = plainToInstance(dto as typeof CreateMemberDto, {
      ...mutation.data,
      ...(mutation.data.email === '' ? { email: undefined } : {}),
    });
    try {
      await validateOrReject(input, { whitelist: true, forbidNonWhitelisted: true });
    } catch {
      throw new BadRequestException('Invalid member or visitor fields');
    }
    // This release edits contact details only; identity, branch and lifecycle transitions use domain pages online.
    const fields: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phone: 'phone',
      notes: 'notes',
    };
    if (Object.keys(mutation.data).some((key) => !(key in fields)))
      throw new BadRequestException('Field is not supported offline');
    const data: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(mutation.data)) {
      if (typeof value !== 'string' || value.length > 5000)
        throw new BadRequestException('Invalid contact field');
      data[fields[key]] = value.trim() || null;
    }
    if (!data.first_name || (isMember && !data.last_name))
      throw new BadRequestException('Name is required');
    if (isMember && data.phone) {
      const duplicate = await tx.member.findFirst({
        where: {
          church_id: scope.church_id,
          phone: data.phone,
          id: { not: mutation.entityId },
          archived_at: null,
        },
      });
      if (duplicate) throw new ConflictException('A member already uses this phone number');
    }
    const model = isMember ? tx.member : tx.visitor;
    const existing = await (model.findFirst as typeof tx.member.findFirst)({
      where: {
        id: mutation.entityId,
        ...scope,
        archived_at: null,
        ...(!isMember ? { deleted_at: null } : {}),
      },
    });
    if (mutation.action === 'create') {
      if (existing) throw new ConflictException('Record already exists');
      const created = isMember
        ? await tx.member.create({
            data: {
              ...scope,
              ...data,
              id: mutation.entityId,
              first_name: data.first_name!,
              last_name: data.last_name!,
            },
          })
        : await tx.visitor.create({
            data: { ...scope, ...data, id: mutation.entityId, first_name: data.first_name! },
          });
      return created.updated_at.toISOString();
    }
    if (!existing) throw new ConflictException('Record is no longer available in this branch');
    if (
      !mutation.baseVersion ||
      existing.updated_at.toISOString() !== new Date(mutation.baseVersion).toISOString()
    )
      throw new ConflictException('This record changed online. Review your changes.');
    const updatedAt = new Date(Math.max(Date.now(), existing.updated_at.getTime() + 1));
    const updated = await (model.updateMany as typeof tx.member.updateMany)({
      where: {
        id: mutation.entityId,
        ...scope,
        archived_at: null,
        updated_at: existing.updated_at,
      },
      data: { ...data, updated_at: updatedAt },
    });
    if (updated.count !== 1)
      throw new ConflictException('This record changed online. Review your changes.');
    return updatedAt.toISOString();
  }

  private async submission(
    tx: Prisma.TransactionClient,
    scope: { church_id: string; branch_id: string },
    mutation: OfflineMutationDto,
    userId: string,
  ) {
    // Locks the form across offline submitters to enforce limits and uniqueness.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`offline-form:${mutation.formId}`}, 0))`;
    const form = await tx.form.findFirst({
      where: {
        id: mutation.formId,
        ...scope,
        archived_at: null,
        status: 'published',
        is_template: false,
      },
    });
    if (!form) throw new ConflictException('Form no longer accepts submissions');
    if (
      !mutation.baseVersion ||
      form.updated_at.toISOString() !== new Date(mutation.baseVersion).toISOString()
    )
      throw new ConflictException('The form changed. Review the latest fields.');
    this.forms.validateSubmissionData(form.fields as unknown as FormFieldDto[], mutation.data);
    const prior = await tx.formSubmission.findFirst({
      where: { church_id: scope.church_id, form_id: form.id, submitted_by: userId },
    });
    if (prior) throw new ConflictException('You have already submitted this form');
    if (
      form.submission_limit > 0 &&
      (await tx.formSubmission.count({
        where: { church_id: scope.church_id, form_id: form.id },
      })) >= form.submission_limit
    )
      throw new ConflictException('The submission limit was reached');
    if (form.unique_field && mutation.data[form.unique_field] !== undefined) {
      const duplicate = await tx.formSubmission.findFirst({
        where: {
          church_id: scope.church_id,
          form_id: form.id,
          data: {
            path: [form.unique_field],
            equals: mutation.data[form.unique_field] as Prisma.InputJsonValue,
          },
        },
      });
      if (duplicate)
        throw new ConflictException('This form already has a submission with that value');
    }
    const row = await tx.formSubmission.create({
      data: {
        id: mutation.entityId,
        church_id: scope.church_id,
        form_id: form.id,
        data: mutation.data as Prisma.InputJsonValue,
        submitted_by: userId,
      },
    });
    return row.created_at.toISOString();
  }
}
