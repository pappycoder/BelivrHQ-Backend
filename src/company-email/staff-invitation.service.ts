import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CompanyEmailService } from './company-email.service';
import { publicWebUrl } from './public-web-url';

export interface StaffInvitationInput {
  churchId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  phone?: string | null;
  branchId?: string | null;
  inviterUserId: string;
}

@Injectable()
export class StaffInvitationService {
  private readonly logger = new Logger(StaffInvitationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly emails: CompanyEmailService,
    private readonly config: ConfigService,
  ) {}

  async create(input: StaffInvitationInput) {
    this.emails.assertInvitationDeliveryConfigured();
    const origin = publicWebUrl(this.config);
    const [church, inviter, role] = await Promise.all([
      this.prisma.church.findUnique({ where: { id: input.churchId }, select: { name: true } }),
      this.prisma.profile.findFirst({
        where: { user_id: input.inviterUserId, church_id: input.churchId },
        select: { first_name: true, last_name: true },
      }),
      this.prisma.role.findFirst({
        where: { name: input.role, OR: [{ church_id: null }, { church_id: input.churchId }] },
        select: { name: true, label: true },
      }),
    ]);
    if (!church) throw new NotFoundException('Church not found');
    if (!role || ['super_admin', 'member'].includes(input.role))
      throw new BadRequestException('Invalid church invitation role');
    const { data, error } = await this.supabase.client.auth.admin.generateLink({
      type: 'invite',
      email: input.email,
      options: { redirectTo: new URL('/accept-invitation', origin).href },
    });
    if (error || !data.user || !data.properties?.hashed_token)
      throw new BadRequestException(
        'Unable to create invitation. Confirm the email is not already registered.',
      );
    const userId = data.user.id;
    // Never delete or reassign an existing church account, even if the provider returns it.
    if (await this.prisma.profile.findUnique({ where: { user_id: userId }, select: { id: true } }))
      throw new ConflictException('This email already has a BelivrHQ account');
    const accept = new URL('/accept-invitation', origin);
    accept.hash = new URLSearchParams({ token_hash: data.properties.hashed_token }).toString();
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.profile.create({
          data: {
            user_id: userId,
            church_id: input.churchId,
            branch_id: input.branchId || null,
            role: [input.role],
            is_admin_hq: input.role === 'church_admin',
            first_name: input.firstName,
            last_name: input.lastName,
            phone: input.phone || null,
            email: input.email,
          },
        });
        const eventKey = await this.emails.enqueueInvitation(tx, {
          userId,
          churchId: input.churchId,
          email: input.email,
          firstName: input.firstName,
          churchName: church.name,
          roleLabel:
            role.label || role.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          inviterName: inviter
            ? `${inviter.first_name} ${inviter.last_name}`.trim()
            : 'Your church administrator',
          acceptUrl: accept.href,
        });
        return { profile, eventKey };
      });
    } catch (error) {
      await this.supabase.client.auth.admin.deleteUser(userId).catch(() => {
        this.logger.warn('Invitation identity cleanup requires review');
      });
      throw error;
    }
    await this.emails.dispatch(result.eventKey).catch(() => {
      this.logger.warn('Invitation email is queued for delivery retry');
    });
    return result.profile;
  }
}
