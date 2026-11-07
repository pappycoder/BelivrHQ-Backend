import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IntakeLink, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { MembersService } from '../members/members.service';
import { VisitorsService } from '../visitors/visitors.service';
import { CreateMemberDto } from '../members/dto/create-member.dto';
import { CreateVisitorDto } from '../visitors/dto/create-visitor.dto';
import { churchEntitlements } from '../billing/entitlements';
import { IntakeListDto } from './intake.dto';
import { intakeFields, validateIntake } from './intake-fields';

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: BranchScopeService,
    private readonly audit: AuditLoggingService,
    private readonly members: MembersService,
    private readonly visitors: VisitorsService,
  ) {}

  authorize(viewer: ViewerScope, kind: string, review = false) {
    const permissions = viewer.permissions ?? [];
    const read = kind === 'members' ? 'members:all:read' : 'visitors:list:read';
    if (!permissions.includes(`${kind}:new:create`) || (review && !permissions.includes(read)))
      throw new ForbiddenException('You do not have permission to manage these registrations');
  }

  private async activeBranch(
    churchId: string,
    branchId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const branch = await db.branch.findFirst({
      where: {
        id: branchId,
        church_id: churchId,
        archived_at: null,
        church: { archived_at: null },
      },
      include: { church: true },
    });
    if (!branch) throw new NotFoundException('Registration form is unavailable');
    return branch;
  }

  async link(viewer: ViewerScope, kind: 'members' | 'visitors', branchId: string) {
    this.authorize(viewer, kind);
    if (!this.scope.isVisible(viewer, branchId))
      throw new ForbiddenException('You can only manage links in your branch');
    const branch = await this.activeBranch(viewer.church_id, branchId);
    const link = await this.prisma.intakeLink.upsert({
      where: {
        church_id_branch_id_kind: { church_id: viewer.church_id, branch_id: branchId, kind },
      },
      create: {
        church_id: viewer.church_id,
        branch_id: branchId,
        kind,
        token: randomBytes(32).toString('hex'),
      },
      update: { kind },
    });
    return { token: link.token, branchName: branch.name, kind };
  }

  private async publicLink(token: string) {
    const link = await this.prisma.intakeLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('Registration form is unavailable');
    const branch = await this.activeBranch(link.church_id, link.branch_id);
    if (!(await churchEntitlements(this.prisma, link.church_id)).active)
      throw new NotFoundException('Registration form is unavailable');
    return { link, branch };
  }

  private async fields(link: IntakeLink, db: Prisma.TransactionClient = this.prisma) {
    const custom = await db.customFieldDefinition.findMany({
      where: { church_id: link.church_id, is_active: true, archived_at: null },
      orderBy: { display_order: 'asc' },
    });
    return { custom, fields: intakeFields(link.kind, custom) };
  }

  async meta(token: string) {
    const { link, branch } = await this.publicLink(token);
    const { fields } = await this.fields(link);
    return {
      title: link.kind === 'members' ? 'Member registration' : 'Visitor registration',
      kind: link.kind,
      churchName: branch.church.name,
      churchLogoUrl: branch.church.logo_url,
      branchName: branch.name,
      fields,
    };
  }

  private async answers(
    link: IntakeLink,
    input: Record<string, unknown>,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const { custom, fields } = await this.fields(link, db);
    const data = validateIntake(fields, input);
    const standard = Object.fromEntries(
      Object.entries(data).filter(([key]) => !key.startsWith('custom:')),
    );
    const customFields = Object.fromEntries(
      custom
        .filter((c) => data[`custom:${c.id}`] !== undefined)
        .map((c) => [c.name, data[`custom:${c.id}`]]),
    );
    const raw = { ...standard, customFields, branchId: link.branch_id };
    const dto =
      link.kind === 'members'
        ? plainToInstance(CreateMemberDto, raw)
        : plainToInstance(CreateVisitorDto, raw);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length)
      throw new BadRequestException(errors.flatMap((e) => Object.values(e.constraints ?? {})));
    if (String(data.firstName).length > 100 || String(data.lastName ?? '').length > 100)
      throw new BadRequestException('Names must be at most 100 characters');
    return { data, dto };
  }

  async submit(token: string, input: Record<string, unknown>) {
    const { link } = await this.publicLink(token);
    const { data } = await this.answers(link, input);
    const response = await this.prisma.intakeSubmission.create({
      data: {
        church_id: link.church_id,
        branch_id: link.branch_id,
        kind: link.kind,
        link_id: link.id,
        data: data as Prisma.InputJsonObject,
        search_text: this.searchText(data),
      },
    });
    return { id: response.id, message: 'Your registration has been sent for review.' };
  }

  private searchText(data: Record<string, unknown>) {
    return ['firstName', 'lastName', 'email', 'phone', 'whatsappNumber']
      .map((key) => String(data[key] ?? ''))
      .join(' ');
  }

  private where(viewer: ViewerScope, kind: string, branchId?: string) {
    this.authorize(viewer, kind, true);
    const scope = this.scope.resolve(viewer);
    return {
      church_id: viewer.church_id,
      kind,
      ...(scope.churchOnly
        ? branchId
          ? { branch_id: branchId }
          : {}
        : { branch_id: scope.branchId }),
    };
  }

  async list(viewer: ViewerScope, query: IntakeListDto) {
    const where = {
      ...this.where(viewer, query.kind, query.branchId),
      status: 'pending',
      ...(query.search?.trim()
        ? { search_text: { contains: query.search.trim(), mode: 'insensitive' as const } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.intakeSubmission.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.intakeSubmission.count({ where }),
    ]);
    const branches = await this.prisma.branch.findMany({
      where: {
        church_id: viewer.church_id,
        id: { in: [...new Set(rows.map((r) => r.branch_id))] },
      },
      select: { id: true, name: true },
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        data: r.data,
        branchId: r.branch_id,
        branchName: branches.find((b) => b.id === r.branch_id)?.name,
        createdAt: r.created_at,
      })),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async detail(viewer: ViewerScope, kind: string, id: string) {
    const row = await this.prisma.intakeSubmission.findFirst({
      where: { ...this.where(viewer, kind), id, status: 'pending' },
      include: { link: true },
    });
    if (!row) throw new NotFoundException('Pending registration not found');
    const branch = await this.prisma.branch.findFirst({
      where: { id: row.branch_id, church_id: row.church_id },
      select: { name: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const { fields } = await this.fields(row.link);
    return {
      id: row.id,
      data: Object.fromEntries(
        Object.entries(row.data as Record<string, unknown>).filter(([key]) =>
          fields.some((f) => f.key === key),
        ),
      ),
      fields,
      branchName: branch.name,
      createdAt: row.created_at,
    };
  }

  async accept(
    viewer: ViewerScope,
    kind: string,
    id: string,
    input: Record<string, unknown>,
    userId: string,
  ) {
    const where = { ...this.where(viewer, kind), id };
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize approvals within this church, including duplicate checks.
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${viewer.church_id} FOR UPDATE`;
      const row = await tx.intakeSubmission.findFirst({ where, include: { link: true } });
      if (!row) throw new NotFoundException('Pending registration not found');
      if (row.status !== 'pending')
        throw new ConflictException('This registration has already been reviewed');
      await this.activeBranch(row.church_id, row.branch_id, tx);
      const { data, dto } = await this.answers(row.link, input, tx);
      const record =
        kind === 'members'
          ? await this.members.createMember(dto as CreateMemberDto, row.church_id, userId, tx)
          : await this.visitors.create(dto as CreateVisitorDto, row.church_id, userId, viewer, tx);
      const destinationId = 'memberId' in record ? record.memberId : record.id;
      await tx.intakeSubmission.update({
        where: { id, church_id: viewer.church_id },
        data: {
          status: 'accepted',
          data: data as Prisma.InputJsonObject,
          search_text: this.searchText(data),
          destination_id: destinationId,
          reviewed_by: userId,
          reviewed_at: new Date(),
        },
      });
      return { destinationId, record, dto };
    });
    if ('memberId' in result.record)
      await this.members
        .afterMemberCreated(result.dto as CreateMemberDto, viewer.church_id, userId, result.record)
        .catch(() => this.logger.error('Accepted registration notification failed'));
    else
      await this.audit.log({
        userId,
        churchId: viewer.church_id,
        entity: 'visitor',
        action: 'CREATE',
        entityId: result.destinationId,
        newValues: { first_name: result.dto.firstName, last_name: result.dto.lastName },
      });
    await this.audit.log({
      userId,
      churchId: viewer.church_id,
      entity: 'intake_submission',
      action: 'UPDATE',
      entityId: id,
      newValues: { status: 'accepted', destinationId: result.destinationId },
    });
    return { destinationId: result.destinationId };
  }

  async reject(viewer: ViewerScope, kind: string, id: string, userId: string) {
    const where = { ...this.where(viewer, kind), id, status: 'pending' };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${viewer.church_id} FOR UPDATE`;
      return tx.intakeSubmission.deleteMany({ where });
    });
    if (!result.count) throw new NotFoundException('Pending registration not found');
    await this.audit.log({
      userId,
      churchId: viewer.church_id,
      entity: 'intake_submission',
      action: 'DELETE',
      entityId: id,
    });
    return { success: true };
  }
}
