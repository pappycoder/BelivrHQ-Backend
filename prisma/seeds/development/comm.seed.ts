/**
 * @file comm.seed.ts
 * @description Seeds communication data: forms + submissions, message/email
 * templates + broadcasts + messages, internal emails, notifications, and
 * custom-field definitions.
 */

import {
  Prisma,
  PrismaClient,
  MessageDirection,
  SubmissionStatus,
  FormStatus,
} from '@prisma/client';

export interface CommSeedResult {
  formCount: number;
  broadcastCount: number;
}

export async function seedComm(
  prisma: PrismaClient,
  churchId: string,
  hqBranchId: string,
  lekkiBranchId: string,
  members: {
    id: string;
    first_name: string;
    phone: string | null;
  }[],
  profiles: Record<string, string>,
): Promise<CommSeedResult> {
  console.log('📦 Seeding communication data...');

  let formCount = 0;
  let broadcastCount = 0;

  // ── Public non-template form ──────────────────────────────────────
  let eventForm = await prisma.form.findFirst({
    where: {
      church_id: churchId,
      title: 'Event Registration (Public)',
    },
  });

  if (!eventForm) {
    eventForm = await prisma.form.create({
      data: {
        church_id: churchId,
        title: 'Event Registration (Public)',
        description: 'Public registration for church events',
        fields: [
          {
            key: 'full_name',
            label: 'Full Name',
            type: 'text',
            required: true,
          },
          {
            key: 'email',
            label: 'Email',
            type: 'email',
            required: true,
          },
        ] as Prisma.InputJsonValue,
        status: FormStatus.published,
        is_template: false,
        is_public: true,
        public_token: crypto.randomUUID(),
        unique_field: 'email',
        submission_limit: 100,
      },
    });

    formCount++;
  }

  // ── Submissions against the Membership Application template ───────
  const membershipForm = await prisma.form.findFirst({
    where: {
      church_id: churchId,
      title: 'Membership Application',
    },
  });

  if (membershipForm) {
    const submissionCount = await prisma.formSubmission.count({
      where: {
        form_id: membershipForm.id,
      },
    });

    if (submissionCount === 0) {
      await prisma.formSubmission.create({
        data: {
          form_id: membershipForm.id,
          church_id: churchId,
          status: SubmissionStatus.approved,
          data: {
            full_name: 'Adaobi Eze',
            email: 'adaobi.eze@gmail.com',
            phone: '+234 809 000 1111',
          } as Prisma.InputJsonValue,
          approved_by_id: profiles['church_admin'],
          approved_at: new Date('2026-08-01T10:00:00Z'),
        },
      });

      await prisma.formSubmission.create({
        data: {
          form_id: membershipForm.id,
          church_id: churchId,
          status: SubmissionStatus.pending,
          data: {
            full_name: 'Bola Adeyinka',
            email: 'bola.adeyinka@gmail.com',
            phone: '+234 802 222 3333',
          } as Prisma.InputJsonValue,
        },
      });

      await prisma.formSubmission.create({
        data: {
          form_id: membershipForm.id,
          church_id: churchId,
          status: SubmissionStatus.rejected,
          data: {
            full_name: 'Kola Alabi',
            email: 'kola.alabi@outlook.com',
            phone: '+234 803 444 5555',
          } as Prisma.InputJsonValue,
          rejection_reason: 'Duplicate application — already a member.',
        },
      });
    }
  }

  // ── Templates ─────────────────────────────────────────────────────
  const templateDefs: Array<{
    name: string;
    content: string;
    channel: string;
    status: string;
    category: string | null;
  }> = [
    {
      name: 'Welcome Message',
      content: 'Welcome to Grace Community Church! We are glad to have you.',
      channel: 'whatsapp',
      status: 'published',
      category: 'UTILITY',
    },
    {
      name: 'Service Reminder',
      content: 'Reminder: Sunday service starts at 9am. See you there!',
      channel: 'sms',
      status: 'published',
      category: null,
    },
    {
      name: 'Prayer Request Acknowledgment',
      content: 'We have received your prayer request and will pray with you.',
      channel: 'email',
      status: 'draft',
      category: null,
    },
  ];

  for (const template of templateDefs) {
    const existing = await prisma.template.findFirst({
      where: {
        church_id: churchId,
        name: template.name,
        channel: template.channel,
      },
    });

    if (existing) {
      continue;
    }

    await prisma.template.create({
      data: {
        church_id: churchId,
        name: template.name,
        content: template.content,
        channel: template.channel,
        status: template.status,
        category: template.category ?? undefined,
        variables: ['first_name'] as Prisma.InputJsonValue,
      },
    });
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  const welcomeTemplate = await prisma.template.findFirst({
    where: {
      church_id: churchId,
      name: 'Welcome Message',
      channel: 'whatsapp',
    },
  });

  const broadcastCountDb = await prisma.broadcast.count({
    where: {
      church_id: churchId,
    },
  });

  if (welcomeTemplate && broadcastCountDb === 0) {
    const recipientCount = Math.min(4, members.length);

    const broadcast = await prisma.broadcast.create({
      data: {
        church_id: churchId,
        name: 'September Welcome Blast',
        template_id: welcomeTemplate.id,
        channel: 'whatsapp',
        audience_filter: {
          members: 'all',
        } as Prisma.InputJsonValue,
        status: 'sent',
        sent_at: new Date('2026-09-01T09:00:00Z'),
        total_recipients: recipientCount,
      },
    });

    for (let i = 0; i < recipientCount; i++) {
      const member = members[i];

      await prisma.broadcastRecipient.create({
        data: {
          broadcast_id: broadcast.id,
          member_id: member.id,
          phone: member.phone ?? '+234 800 000 0000',
          status: 'sent',
          sent_at: new Date('2026-09-01T09:00:05Z'),
        },
      });
    }

    broadcastCount++;
  }

  // ── Messages ──────────────────────────────────────────────────────
  const messageCount = await prisma.message.count({
    where: {
      church_id: churchId,
    },
  });

  if (messageCount === 0) {
    if (members[0]) {
      await prisma.message.create({
        data: {
          church_id: churchId,
          member_id: members[0].id,
          phone: members[0].phone ?? '+234 803 456 7890',
          direction: MessageDirection.inbound,
          channel: 'whatsapp',
          content: 'Please pray for my family this week.',
          status: 'received',
          metadata: {
            seed: true,
          } as Prisma.InputJsonValue,
        },
      });
    }

    if (members[2]) {
      await prisma.message.create({
        data: {
          church_id: churchId,
          member_id: members[2].id,
          phone: members[2].phone ?? '+234 807 890 1234',
          direction: MessageDirection.outbound,
          channel: 'whatsapp',
          content: 'God bless you, Emeka! See you on Sunday.',
          status: 'delivered',
          metadata: {
            seed: true,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // ── Internal emails ────────────────────────────────────────────────
  const admin = profiles['church_admin'];
  const secretary = profiles['secretary'];
  const seniorPastor = profiles['senior_pastor'];

  if (admin && secretary && seniorPastor) {
    const existing = await prisma.emailMessage.findFirst({
      where: {
        church_id: churchId,
        subject: 'Welcome to the admin dashboard',
      },
    });

    if (!existing) {
      const message = await prisma.emailMessage.create({
        data: {
          church_id: churchId,
          sender_id: admin,
          sender_name: 'Grace Okafor',
          subject: 'Welcome to the admin dashboard',
          body: 'Hi! This is an internal email to help you test the email module. Explore the inbox and sent boxes.',
        },
      });

      const recipientIds = [secretary, seniorPastor];

      for (const profileId of recipientIds) {
        await prisma.emailRecipient.create({
          data: {
            message_id: message.id,
            profile_id: profileId,
          },
        });
      }
    }
  }

  const branchSecretary = profiles['branch_secretary'];
  const branchPastor = profiles['branch_pastor'];

  if (branchSecretary && branchPastor) {
    const existing = await prisma.emailMessage.findFirst({
      where: {
        church_id: churchId,
        subject: 'Lekki service rota',
      },
    });

    if (!existing) {
      const message = await prisma.emailMessage.create({
        data: {
          church_id: churchId,
          sender_id: branchSecretary,
          sender_name: 'Ifeoma Eze',
          subject: 'Lekki service rota',
          body: 'Please find the attached rota for October.',
        },
      });

      await prisma.emailRecipient.create({
        data: {
          message_id: message.id,
          profile_id: branchPastor,
        },
      });
    }
  }

  // ── Notifications ──────────────────────────────────────────────────
  const notifDefs: Array<{
    type: string;
    title: string;
    body: string;
    profileKey: string;
  }> = [
    {
      type: 'system',
      title: 'Welcome to BelivrHQ',
      body: 'You have been provisioned with a staff account.',
      profileKey: 'church_admin',
    },
    {
      type: 'attendance',
      title: 'Attendance milestone',
      body: 'Your branch hit 95% attendance last Sunday.',
      profileKey: 'branch_pastor',
    },
    {
      type: 'giving',
      title: 'New donation received',
      body: 'A member donated ₦10,000 to Building Project.',
      profileKey: 'treasurer',
    },
    {
      type: 'event',
      title: 'Event reminder',
      body: 'Annual Leadership Conference starts in 3 days.',
      profileKey: 'secretary',
    },
    {
      type: 'broadcast',
      title: 'Broadcast sent',
      body: 'Your September Welcome Blast was delivered.',
      profileKey: 'church_admin',
    },
  ];

  for (const notification of notifDefs) {
    const profileId = profiles[notification.profileKey];

    if (!profileId) {
      continue;
    }

    const existing = await prisma.notification.findFirst({
      where: {
        church_id: churchId,
        profile_id: profileId,
        title: notification.title,
      },
    });

    if (existing) {
      continue;
    }

    await prisma.notification.create({
      data: {
        church_id: churchId,
        profile_id: profileId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        data: {
          seed: true,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ── Custom field definitions ───────────────────────────────────────
  const cfDefs: Array<{
    name: string;
    type: string;
    required: boolean;
  }> = [
    {
      name: 'emergency_contact',
      type: 'text',
      required: true,
    },
    {
      name: 'baptised',
      type: 'checkbox',
      required: false,
    },
    {
      name: 'wedding_anniversary',
      type: 'date',
      required: false,
    },
  ];

  for (let i = 0; i < cfDefs.length; i++) {
    const field = cfDefs[i];

    const existing = await prisma.customFieldDefinition.findFirst({
      where: {
        church_id: churchId,
        name: field.name,
      },
    });

    if (existing) {
      continue;
    }

    await prisma.customFieldDefinition.create({
      data: {
        church_id: churchId,
        name: field.name,
        field_type: field.type,
        is_required: field.required,
        display_order: i + 1,
      },
    });
  }

  console.log(
    `  🎉 Communication seed done (forms: ${formCount} new, broadcasts: ${broadcastCount} new)`,
  );

  return {
    formCount,
    broadcastCount,
  };
}
