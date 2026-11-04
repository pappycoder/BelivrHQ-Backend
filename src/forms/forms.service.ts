import { contentBranch } from '../common/services/content-branch';
import { assertPlanFeature } from '../billing/entitlements';
/**
 * @file forms.service.ts
 * @description Business logic for forms and form submissions.
 *
 * Provides CRUD for form definitions, template cloning, data validation,
 * submission handling, file attachments, and a simple approval workflow.
 *
 * All queries are scoped by church_id for multi-tenant data isolation.
 * All mutations are audit-logged.
 *
 * @module forms/forms.service
 * @since 1.0.0
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Form, FormSubmission, FormStatus, Prisma, SubmissionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import {
  CreateFormDto,
  CreateFormSubmissionDto,
  FormFieldDto,
  FormFieldType,
  FormResponseDto,
  FormSubmissionResponseDto,
  ListFormsDto,
  ListFormSubmissionsDto,
  SubmissionAttachmentDto,
  UpdateFormDto,
  UpdateSubmissionStatusDto,
} from './dto';

/**
 * Attachment input extracted from media assets before storing on a submission.
 */
/**
 * Paginated list result used internally by the service.
 */
interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Service for managing church forms and submissions.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly branchScope: BranchScopeService,
  ) {}

  // ─── Forms ────────────────────────────────────────────────

  /**
   * Creates a new form scoped to a church.
   *
   * @param churchId - Church ID
   * @param dto - Form creation data
   * @param userId - ID of the user creating the form
   * @returns Created form response
   */
  async createForm(
    churchId: string,
    dto: CreateFormDto,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FormResponseDto> {
    this.validateFieldDefinitions(dto.fields);
    const scope = this.branchScope.resolve(viewer);
    const branchId = await contentBranch(this.prisma, scope, churchId, dto.branchId);

    const form = await this.prisma.form.create({
      include: { branch: { select: { name: true } } },
      data: {
        church_id: churchId,
        branch_id: branchId,
        title: dto.title,
        description: dto.description,
        fields: dto.fields as unknown as Prisma.InputJsonValue,
        status: dto.status ?? FormStatus.draft,
        is_template: dto.isTemplate ?? false,
        is_public: dto.isPublic ?? false,
        public_token: dto.isPublic ? randomUUID() : null,
        unique_field: dto.uniqueField ?? null,
        submission_limit: dto.submissionLimit ?? 0,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'CREATE',
      entityId: form.id,
      newValues: this.formToPlain(form),
    });

    return this.mapForm(form);
  }

  /**
   * Lists forms for a church with optional filters and pagination.
   *
   * @param churchId - Church ID
   * @param query - List filters
   * @returns Paginated form list
   */
  async listForms(
    churchId: string,
    query: ListFormsDto,
    viewer?: ViewerScope | null,
  ): Promise<PaginatedResult<FormResponseDto>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: Prisma.FormWhereInput = {
      church_id: churchId,
      archived_at: query.archived === true ? { not: null } : null,
    };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly)
      where.AND = [{ OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }];
    else if (scope.churchOnly && query.branchId)
      where.AND = [{ OR: [{ branch_id: query.branchId }, { branch_id: null }] }];

    if (query.status) where.status = query.status;
    if (query.isTemplate !== undefined) where.is_template = query.isTemplate;
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const orderDirection = query.sortOrder ?? (query.sortBy === 'title' ? 'asc' : 'desc');
    const orderBy: Prisma.FormOrderByWithRelationInput =
      query.sortBy === 'title'
        ? { title: orderDirection }
        : query.sortBy === 'createdAt'
          ? { created_at: orderDirection }
          : query.sortBy === 'submissionCount'
            ? { submissions: { _count: orderDirection } }
            : { updated_at: orderDirection };

    const [total, forms] = await Promise.all([
      this.prisma.form.count({ where }),
      this.prisma.form.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: { branch: { select: { name: true } }, _count: { select: { submissions: true } } },
      }),
    ]);

    return {
      items: forms.map((form) => this.mapForm(form)),
      total,
      page,
      limit,
    };
  }

  /**
   * Gets a single form by ID within a church.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @returns Form response
   */
  async getForm(
    churchId: string,
    formId: string,
    viewer?: ViewerScope | null,
  ): Promise<FormResponseDto> {
    const form = await this.findFormOrFail(churchId, formId);
    if (form.branch_id && !this.branchScope.isVisible(viewer, form.branch_id))
      throw new NotFoundException('Form not found');
    return this.mapForm(form);
  }

  /**
   * Updates an existing form.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param dto - Update data
   * @param userId - User making the update
   * @returns Updated form response
   */
  async updateForm(
    churchId: string,
    formId: string,
    dto: UpdateFormDto,
    userId: string,
  ): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);
    const oldValues = this.formToPlain(existing);
    const branchId =
      dto.branchId !== undefined
        ? await contentBranch(this.prisma, this.branchScope.resolve(), churchId, dto.branchId)
        : undefined;

    if (existing.archived_at) {
      throw new NotFoundException('Form is archived');
    }

    if (dto.fields) {
      this.validateFieldDefinitions(dto.fields);
    }

    const isPublic = dto.isPublic ?? existing.is_public;
    const publicToken = isPublic && !existing.public_token ? randomUUID() : existing.public_token;

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: {
        branch_id: branchId,
        title: dto.title,
        description: dto.description,
        fields: dto.fields
          ? (dto.fields as unknown as Prisma.InputJsonValue)
          : (existing.fields as Prisma.InputJsonValue),
        status: dto.status,
        is_template: dto.isTemplate,
        is_public: dto.isPublic,
        public_token: publicToken,
        unique_field: dto.uniqueField !== undefined ? dto.uniqueField : undefined,
        submission_limit: dto.submissionLimit !== undefined ? dto.submissionLimit : undefined,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'UPDATE',
      entityId: form.id,
      oldValues,
      newValues: this.formToPlain(form),
    });

    return this.mapForm(form);
  }

  /**
   * Closes a form by setting its status to closed.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Success indicator
   */
  async deleteForm(
    churchId: string,
    formId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const existing = await this.findFormOrFail(churchId, formId);

    await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { status: FormStatus.closed },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'DELETE',
      entityId: formId,
      oldValues: this.formToPlain(existing),
    });

    return { success: true };
  }

  /**
   * Clones a form (typically a template) into a new draft form.
   *
   * @param churchId - Church ID
   * @param formId - Form ID to clone
   * @param userId - User cloning the form
   * @returns Cloned form response
   */
  async cloneForm(churchId: string, formId: string, userId: string): Promise<FormResponseDto> {
    const source = await this.findFormOrFail(churchId, formId);
    const scope = this.branchScope.resolve();

    if (source.archived_at) {
      throw new NotFoundException('Form is archived');
    }

    const form = await this.prisma.form.create({
      include: { branch: { select: { name: true } } },
      data: {
        church_id: churchId,
        branch_id: scope.churchOnly ? source.branch_id : scope.branchId,
        title: `${source.title} (Copy)`,
        description: source.description,
        fields: source.fields as Prisma.InputJsonValue,
        status: FormStatus.draft,
        is_template: false,
        is_public: false,
        public_token: null,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'CREATE',
      entityId: form.id,
      newValues: this.formToPlain(form),
    });

    return this.mapForm(form);
  }

  /**
   * Archives a form by setting archived_at. Archived forms drop out of active
   * lists but stay reachable by ID, and can be restored or purged.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Updated form response
   * @throws NotFoundException if the form is missing or not in this church
   * @throws ConflictException if the form is already archived
   */
  async archiveForm(churchId: string, formId: string, userId: string): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);

    if (existing.archived_at) {
      throw new ConflictException('Form is already archived');
    }

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'ARCHIVE',
      entityId: formId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: form.archived_at },
    });

    return this.mapForm(form);
  }

  /**
   * Restores an archived form by clearing archived_at.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Updated form response
   * @throws NotFoundException if the form is missing or not in this church
   * @throws ConflictException if the form is not currently archived
   */
  async restoreForm(churchId: string, formId: string, userId: string): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);

    if (!existing.archived_at) {
      throw new ConflictException('Form is not archived');
    }

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'RESTORE',
      entityId: formId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    return this.mapForm(form);
  }

  /**
   * Closes a form by setting its status to closed, stopping further submissions.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Updated form response
   * @throws NotFoundException if the form is missing or not in this church
   * @throws ConflictException if the form is already closed or archived
   */
  async closeForm(churchId: string, formId: string, userId: string): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);

    if (existing.status === FormStatus.closed) {
      throw new ConflictException('Form is already closed');
    }
    if (existing.archived_at) {
      throw new ConflictException('Form is archived');
    }

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { status: FormStatus.closed },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'UPDATE',
      entityId: formId,
      oldValues: { status: existing.status },
      newValues: { status: form.status },
    });

    return this.mapForm(form);
  }

  /**
   * Reopens a closed form by returning it to draft so it can be edited and
   * re-published.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Updated form response
   * @throws NotFoundException if the form is missing or not in this church
   * @throws ConflictException if the form is not currently closed
   */
  async reopenForm(churchId: string, formId: string, userId: string): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);

    if (existing.status !== FormStatus.closed) {
      throw new ConflictException('Only a closed form can be reopened');
    }

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { status: FormStatus.draft },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'UPDATE',
      entityId: formId,
      oldValues: { status: existing.status },
      newValues: { status: form.status },
    });

    return this.mapForm(form);
  }

  /**
   * Regenerates the public submission token, invalidating any previously
   * shared link. The form must be public to have a token.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param userId - User performing the action
   * @returns Updated form response
   * @throws ConflictException if the form is not public
   */
  async regeneratePublicToken(
    churchId: string,
    formId: string,
    userId: string,
  ): Promise<FormResponseDto> {
    const existing = await this.findFormOrFail(churchId, formId);

    if (existing.archived_at) {
      throw new NotFoundException('Form is archived');
    }

    if (!existing.is_public) {
      throw new ConflictException('Form is not public');
    }

    const form = await this.prisma.form.update({
      include: { branch: { select: { name: true } } },
      where: { id: formId },
      data: { public_token: randomUUID() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form',
      action: 'UPDATE',
      entityId: formId,
      oldValues: { public_token: existing.public_token },
      newValues: { public_token: form.public_token },
    });

    return this.mapForm(form);
  }

  // ─── Submissions ──────────────────────────────────────────

  /**
   * Submits a form for an authenticated user.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param dto - Submission data
   * @param submittedBy - User ID of the submitter
   * @returns Created submission response
   */
  async submitForm(
    churchId: string,
    formId: string,
    dto: CreateFormSubmissionDto,
    submittedBy: string,
  ): Promise<FormSubmissionResponseDto> {
    const form = await this.findFormOrFail(churchId, formId);
    this.ensureFormAcceptsSubmissions(form);

    // Reject duplicate submissions by the same authenticated user.
    const existingSubmission = await this.prisma.formSubmission.findFirst({
      where: { form_id: formId, church_id: churchId, submitted_by: submittedBy },
    });
    if (existingSubmission) {
      throw new ConflictException('You have already submitted this form');
    }

    const fields = this.parseFields(form.fields);
    this.validateSubmissionData(fields, dto.data);

    const attachments = await this.resolveAttachments(churchId, dto.attachmentAssetIds);

    const submission = await this.prisma.formSubmission.create({
      data: {
        form_id: formId,
        church_id: churchId,
        data: dto.data as Prisma.InputJsonValue,
        submitted_by: submittedBy,
        status: SubmissionStatus.pending,
        attachments: attachments as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      userId: submittedBy,
      churchId,
      entity: 'form_submission',
      action: 'CREATE',
      entityId: submission.id,
      newValues: this.submissionToPlain(submission),
    });

    return this.mapSubmission(submission);
  }

  /**
   * Returns the public-facing details of a published public form (unauthenticated).
   *
   * Only exposes what a respondent needs to fill the form — title, description,
   * and field definitions. No church or submission data is returned.
   *
   * @param publicToken - Form public token
   * @returns Public form metadata
   * @throws NotFoundException if no such public form exists
   */
  async getPublicFormMeta(publicToken: string): Promise<{
    title: string;
    description?: string;
    fields: FormFieldDto[];
  }> {
    const form = await this.prisma.form.findUnique({
      where: { public_token: publicToken },
    });

    if (!form?.is_public || form.status !== FormStatus.published || form.archived_at) {
      throw new NotFoundException('Form not found');
    }

    await assertPlanFeature(this.prisma, form.church_id, 'forms');

    return {
      title: form.title,
      description: form.description ?? undefined,
      fields: this.parseFields(form.fields),
    };
  }

  /**
   * Submits a form using a public token (unauthenticated).
   *
   * @param publicToken - Form public token
   * @param dto - Submission data
   * @returns Created submission response
   */
  async submitByPublicToken(
    publicToken: string,
    dto: CreateFormSubmissionDto,
  ): Promise<FormSubmissionResponseDto> {
    const form = await this.prisma.form.findUnique({
      where: { public_token: publicToken },
    });

    if (!form) {
      throw new NotFoundException('Form not found');
    }

    if (!form.is_public || form.status !== FormStatus.published) {
      throw new BadRequestException('This form is not accepting public submissions');
    }

    await assertPlanFeature(this.prisma, form.church_id, 'forms');

    const fields = this.parseFields(form.fields);
    this.validateSubmissionData(fields, dto.data);

    // Enforce the submission-level cap (0 = unlimited).
    if (form.submission_limit > 0) {
      const submissionCount = await this.prisma.formSubmission.count({
        where: { form_id: form.id, church_id: form.church_id },
      });
      if (submissionCount >= form.submission_limit) {
        throw new ConflictException(
          `This form has reached its maximum of ${form.submission_limit} submissions`,
        );
      }
    }

    // Enforce unique-field dedupe on public submissions (e.g. email).
    if (form.unique_field) {
      const value = dto.data[form.unique_field];
      if (value !== undefined && value !== null && value !== '') {
        const submissions = await this.prisma.formSubmission.findMany({
          where: { form_id: form.id, church_id: form.church_id },
          select: { data: true },
        });
        const duplicate = submissions.some(
          (s) =>
            String((s.data as Record<string, unknown>)[form.unique_field as string] ?? '') ===
            String(value),
        );
        if (duplicate) {
          const label = fields.find((f) => f.key === form.unique_field)?.label ?? form.unique_field;
          throw new ConflictException(
            `This form has already been submitted with that ${label.toLowerCase()}`,
          );
        }
      }
    }

    const attachments = await this.resolveAttachments(form.church_id, dto.attachmentAssetIds);

    const submission = await this.prisma.formSubmission.create({
      data: {
        form_id: form.id,
        church_id: form.church_id,
        data: dto.data as Prisma.InputJsonValue,
        submitted_by: null,
        status: SubmissionStatus.pending,
        attachments: attachments as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      userId: 'public',
      churchId: form.church_id,
      entity: 'form_submission',
      action: 'CREATE',
      entityId: submission.id,
      newValues: this.submissionToPlain(submission),
    });

    return this.mapSubmission(submission);
  }

  /**
   * Lists submissions for a form.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param query - List filters
   * @returns Paginated submission list
   */
  async listSubmissions(
    churchId: string,
    formId: string,
    query: ListFormSubmissionsDto,
    viewer?: ViewerScope | null,
  ): Promise<PaginatedResult<FormSubmissionResponseDto>> {
    const form = await this.findFormOrFail(churchId, formId);
    if (form.branch_id && !this.branchScope.isVisible(viewer, form.branch_id))
      throw new NotFoundException('Form not found');

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 20;
    const skip = (page - 1) * limit;

    const where: Prisma.FormSubmissionWhereInput = {
      form_id: formId,
      church_id: churchId,
    };

    if (query.status) where.status = query.status;
    if (query.submittedBy) where.submitted_by = query.submittedBy;

    // Prisma cannot LIKE inside a Json column, so a searched read filters
    // BEFORE paging (bounded walk) instead of post-filtering one page and
    // reporting unfiltered totals. Unsearched reads keep native server paging.
    const orderBy: Prisma.FormSubmissionOrderByWithRelationInput = {
      created_at: query.sortOrder ?? 'desc',
    };
    if (query.search) {
      const term = query.search.toLowerCase();
      const matches = (
        await this.prisma.formSubmission.findMany({ where, orderBy, take: 1_000 })
      ).filter((submission) =>
        Object.values(this.mapSubmission(submission).data).some((value) =>
          String(value).toLowerCase().includes(term),
        ),
      );
      const items = matches
        .slice(skip, skip + limit)
        .map((submission) => this.mapSubmission(submission));
      return { items, total: matches.length, page, limit };
    }

    const [total, submissions] = await Promise.all([
      this.prisma.formSubmission.count({ where }),
      this.prisma.formSubmission.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
    ]);

    const items = submissions.map((submission) => this.mapSubmission(submission));

    return { items, total, page, limit };
  }

  /**
   * Gets a single submission by ID within a church and form.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param submissionId - Submission ID
   * @returns Submission response
   */
  async getSubmission(
    churchId: string,
    formId: string,
    submissionId: string,
  ): Promise<FormSubmissionResponseDto> {
    const submission = await this.findSubmissionOrFail(churchId, formId, submissionId);
    return this.mapSubmission(submission);
  }

  /**
   * Updates the approval status of a submission.
   *
   * @param churchId - Church ID
   * @param formId - Form ID
   * @param submissionId - Submission ID
   * @param dto - New status data
   * @param userId - User approving/rejecting
   * @returns Updated submission response
   */
  async updateSubmissionStatus(
    churchId: string,
    formId: string,
    submissionId: string,
    dto: UpdateSubmissionStatusDto,
    userId: string,
  ): Promise<FormSubmissionResponseDto> {
    const submission = await this.findSubmissionOrFail(churchId, formId, submissionId);

    if (submission.status !== SubmissionStatus.pending) {
      throw new BadRequestException('Only pending submissions can be approved or rejected');
    }

    const oldValues = this.submissionToPlain(submission);
    const now = new Date();

    const updated = await this.prisma.formSubmission.update({
      where: { id: submissionId },
      data: {
        status: dto.status,
        approved_by_id: userId,
        approved_at: now,
        rejection_reason: dto.status === SubmissionStatus.rejected ? dto.rejectionReason : null,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'form_submission',
      action: 'UPDATE',
      entityId: updated.id,
      oldValues,
      newValues: this.submissionToPlain(updated),
    });

    return this.mapSubmission(updated);
  }

  // ─── Helpers ──────────────────────────────────────────────

  /**
   * Finds a form scoped to a church or throws NotFoundException.
   */
  private async findFormOrFail(
    churchId: string,
    formId: string,
  ): Promise<Form & { branch?: { name: string } | null; _count?: { submissions: number } }> {
    const form = await this.prisma.form.findFirst({
      where: { id: formId, church_id: churchId },
      include: { branch: { select: { name: true } }, _count: { select: { submissions: true } } },
    });

    if (!form || (form.branch_id && !this.branchScope.isVisible(undefined, form.branch_id))) {
      throw new NotFoundException('Form not found');
    }

    return form;
  }

  /**
   * Finds a submission scoped to a church and form or throws NotFoundException.
   */
  private async findSubmissionOrFail(
    churchId: string,
    formId: string,
    submissionId: string,
  ): Promise<FormSubmission> {
    const scope = this.branchScope.resolve();
    const submission = await this.prisma.formSubmission.findFirst({
      where: {
        id: submissionId,
        church_id: churchId,
        form_id: formId,
        ...(!scope.churchOnly
          ? {
              form: {
                OR: [{ branch_id: scope.branchId }, { branch_id: null }],
              },
            }
          : {}),
      },
    });

    if (!submission) {
      throw new NotFoundException('Submission not found');
    }

    return submission;
  }

  /**
   * Ensures a form is published and accepts submissions.
   */
  private ensureFormAcceptsSubmissions(form: Form): void {
    if (form.status !== FormStatus.published) {
      throw new BadRequestException('This form is not currently accepting submissions');
    }
  }

  /**
   * Parses the JSON fields array from a form record.
   */
  private parseFields(fieldsJson: Prisma.JsonValue): FormFieldDto[] {
    const fields = fieldsJson as unknown as FormFieldDto[] | undefined;
    return Array.isArray(fields) ? fields : [];
  }

  /**
   * Validates that field definitions have unique keys and supported types.
   */
  private validateFieldDefinitions(fields: FormFieldDto[]): void {
    const keys = new Set<string>();
    for (const field of fields) {
      if (!field.key || !field.label) {
        throw new BadRequestException('Every field must have a key and a label');
      }
      if (keys.has(field.key)) {
        throw new BadRequestException(`Duplicate field key: ${field.key}`);
      }
      keys.add(field.key);

      if (!Object.values(FormFieldType).includes(field.type)) {
        throw new BadRequestException(`Unsupported field type: ${field.type}`);
      }

      if (
        (field.type === FormFieldType.DROPDOWN || field.type === FormFieldType.CHECKBOX) &&
        (!Array.isArray(field.options) || field.options.length === 0)
      ) {
        throw new BadRequestException(
          `Field "${field.key}" of type ${field.type} requires options`,
        );
      }
    }
  }

  /**
   * Validates submitted data against the form's field definitions.
   */
  validateSubmissionData(fields: FormFieldDto[], data: Record<string, unknown>): void {
    for (const field of fields) {
      const value = data[field.key];
      const isEmpty = value === undefined || value === null || value === '';

      if (field.required && isEmpty) {
        throw new BadRequestException(`Field "${field.label}" is required`);
      }

      if (isEmpty) {
        continue;
      }

      this.validateFieldValue(field, value);
    }

    const allowedKeys = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(data)) {
      if (!allowedKeys.has(key)) {
        throw new BadRequestException(`Unexpected field: ${key}`);
      }
    }
  }

  /**
   * Validates a single submitted value against its field definition.
   */
  private validateFieldValue(field: FormFieldDto, value: unknown): void {
    switch (field.type) {
      case FormFieldType.TEXT:
      case FormFieldType.TEXTAREA:
      case FormFieldType.EMAIL:
      case FormFieldType.PHONE:
      case FormFieldType.DATE:
        if (typeof value !== 'string') {
          throw new BadRequestException(`Field "${field.label}" must be a string`);
        }
        if (field.type === FormFieldType.EMAIL && !this.isValidEmail(value)) {
          throw new BadRequestException(`Field "${field.label}" must be a valid email`);
        }
        break;
      case FormFieldType.NUMBER:
        if (typeof value !== 'number') {
          throw new BadRequestException(`Field "${field.label}" must be a number`);
        }
        if (field.validation?.min !== undefined && value < field.validation.min) {
          throw new BadRequestException(
            `Field "${field.label}" must be at least ${field.validation.min}`,
          );
        }
        if (field.validation?.max !== undefined && value > field.validation.max) {
          throw new BadRequestException(
            `Field "${field.label}" must be at most ${field.validation.max}`,
          );
        }
        break;
      case FormFieldType.DROPDOWN:
        if (typeof value !== 'string' || !field.options?.includes(value)) {
          throw new BadRequestException(
            `Field "${field.label}" must be one of the allowed options`,
          );
        }
        break;
      case FormFieldType.CHECKBOX:
        if (!Array.isArray(value) || value.some((item) => !field.options?.includes(String(item)))) {
          throw new BadRequestException(`Field "${field.label}" must only use the allowed options`);
        }
        break;
    }
  }

  /**
   * Resolves media asset attachments for a submission.
   */
  private async resolveAttachments(
    churchId: string,
    assetIds?: string[],
  ): Promise<SubmissionAttachmentDto[]> {
    if (!assetIds || assetIds.length === 0) {
      return [];
    }

    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: assetIds }, church_id: churchId },
    });

    if (assets.length !== assetIds.length) {
      throw new BadRequestException('One or more attachment assets are invalid');
    }

    return assets.map((asset) => ({
      assetId: asset.id,
      url: asset.url,
      filename: asset.filename,
      mimeType: asset.mime_type,
    }));
  }

  /**
   * Basic email format validation.
   */
  private isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  /**
   * Maps a Prisma Form record to a FormResponseDto.
   */
  private mapForm(
    form: Form & { branch?: { name: string } | null; _count?: { submissions: number } },
  ): FormResponseDto {
    return {
      id: form.id,
      branchId: form.branch_id ?? undefined,
      branchName: form.branch?.name,
      churchId: form.church_id,
      title: form.title,
      description: form.description ?? undefined,
      fields: this.parseFields(form.fields),
      status: form.status,
      isTemplate: form.is_template,
      isPublic: form.is_public,
      publicToken: form.public_token ?? undefined,
      uniqueField: form.unique_field ?? undefined,
      submissionLimit: form.submission_limit,
      submissionCount: form._count?.submissions ?? 0,
      archivedAt: form.archived_at?.toISOString(),
      createdAt: form.created_at,
      updatedAt: form.updated_at,
    };
  }

  /**
   * Maps a Prisma FormSubmission record to a FormSubmissionResponseDto.
   */
  private mapSubmission(submission: FormSubmission): FormSubmissionResponseDto {
    return {
      id: submission.id,
      formId: submission.form_id,
      churchId: submission.church_id,
      data: submission.data as Record<string, unknown>,
      submittedBy: submission.submitted_by ?? undefined,
      status: submission.status,
      approvedById: submission.approved_by_id ?? undefined,
      approvedAt: submission.approved_at ?? undefined,
      rejectionReason: submission.rejection_reason ?? undefined,
      attachments: (submission.attachments as unknown as SubmissionAttachmentDto[]) || [],
      createdAt: submission.created_at,
    };
  }

  /**
   * Converts a Form record to a plain object for audit logging.
   */
  private formToPlain(form: Form): Record<string, unknown> {
    return {
      id: form.id,
      church_id: form.church_id,
      branch_id: form.branch_id,
      title: form.title,
      description: form.description,
      fields: form.fields,
      status: form.status,
      is_template: form.is_template,
      is_public: form.is_public,
      public_token: form.public_token,
      unique_field: form.unique_field,
      submission_limit: form.submission_limit,
    };
  }

  /**
   * Converts a FormSubmission record to a plain object for audit logging.
   */
  private submissionToPlain(submission: FormSubmission): Record<string, unknown> {
    return {
      id: submission.id,
      form_id: submission.form_id,
      church_id: submission.church_id,
      data: submission.data,
      submitted_by: submission.submitted_by,
      status: submission.status,
      approved_by_id: submission.approved_by_id,
      approved_at: submission.approved_at,
      rejection_reason: submission.rejection_reason,
      attachments: submission.attachments,
    };
  }
}
