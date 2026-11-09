import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CompanyEmailService } from '../../src/company-email/company-email.service';
import { StaffInvitationService } from '../../src/company-email/staff-invitation.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Isolated test database only; neither Supabase nor the email provider is contacted.
describe('staff invitation profile and outbox integrity', () => {
  const prisma = new PrismaService();
  const ids: string[] = [];
  const mail = { sendEmail: jest.fn().mockResolvedValue('accepted-fixture') };
  const config = new ConfigService({
    WEB_URL: 'https://church-os-web.vercel.app',
    RESEND_API_KEY: 'fixture',
    RESEND_FROM: 'team@belivrhq.example',
  });
  const company = new CompanyEmailService(prisma, mail as never, config);
  const generateLink = jest.fn();
  const deleteUser = jest.fn().mockResolvedValue({ error: null });
  const invites = new StaffInvitationService(
    prisma,
    { client: { auth: { admin: { generateLink, deleteUser } } } } as never,
    company,
    config,
  );
  beforeEach(() => {
    mail.sendEmail.mockClear();
    deleteUser.mockClear();
  });
  afterAll(async () => {
    for (const id of ids) {
      await prisma.profile.deleteMany({ where: { church_id: id } });
      await prisma.companyEmailNotification.deleteMany({ where: { church_id: id } });
      await prisma.role.deleteMany({ where: { church_id: id } });
      await prisma.auditLog.deleteMany({ where: { church_id: id } });
      await prisma.church.delete({ where: { id } });
    }
    await prisma.$disconnect();
  });
  async function fixture() {
    const church = await prisma.church.create({ data: { name: 'Invitation test' } });
    ids.push(church.id);
    await prisma.platformSubscription.create({
      data: {
        church_id: church.id,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date(Date.now() + 86400000),
      },
    });
    const role = `invitation_${randomUUID()}`;
    await prisma.role.create({ data: { name: role, label: 'Welcome Team', church_id: church.id } });
    const userId = randomUUID();
    generateLink.mockResolvedValue({
      data: { user: { id: userId }, properties: { hashed_token: 'fixture-token' } },
      error: null,
    });
    return {
      userId,
      input: {
        churchId: church.id,
        email: 'invite@example.org',
        firstName: 'Ada',
        lastName: 'Ola',
        role,
        inviterUserId: randomUUID(),
      },
    };
  }
  it('persists a church profile and branded invitation with the configured live link', async () => {
    const { userId, input } = await fixture();
    const profile = await invites.create(input);
    expect(profile.church_id).toBe(input.churchId);
    expect(profile.role).toEqual([input.role]);
    const row = await prisma.companyEmailNotification.findUniqueOrThrow({
      where: { event_key: `invitation/${userId}` },
    });
    expect(row.kind).toBe('invitation');
    expect(row.status).toBe('sent');
    expect(row.html).toContain(
      'https://church-os-web.vercel.app/accept-invitation#token_hash=fixture-token',
    );
    expect(row.html).toContain('#c8f169');
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });
  it('rolls the profile back if queuing the branded invitation fails', async () => {
    const { userId, input } = await fixture();
    const enqueue = jest
      .spyOn(company, 'enqueueInvitation')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    try {
      await expect(invites.create(input)).rejects.toThrow('outbox unavailable');
      expect(await prisma.profile.findUnique({ where: { user_id: userId } })).toBeNull();
      expect(
        await prisma.companyEmailNotification.count({ where: { church_id: input.churchId } }),
      ).toBe(0);
      expect(deleteUser).toHaveBeenCalledWith(userId);
      expect(mail.sendEmail).not.toHaveBeenCalled();
    } finally {
      enqueue.mockRestore();
    }
  });
});
