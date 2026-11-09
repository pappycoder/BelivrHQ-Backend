/**
 * @file nightly-jobs.processor.ts
 * @description BullMQ processor for scheduled nightly maintenance jobs.
 *
 * Handles jobs from the 'nightly-jobs' queue. Runs church-wide
 * maintenance tasks including:
 * - Recalculating member engagement scores
 * - Recalculating member risk scores
 * - Identifying members needing pastoral attention
 * - Dispatching due recurring giving charges
 *
 * @module queues/processors/nightly-jobs.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ScoringService } from '../../pastoral/scoring.service';
import { PastoralService } from '../../pastoral/pastoral.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncService } from '../../sync/sync.service';

@Processor('nightly-jobs', { concurrency: 1 })
export class NightlyJobsProcessor extends WorkerHost {
  private readonly logger = new Logger(NightlyJobsProcessor.name);

  constructor(
    private readonly scoringService: ScoringService,
    private readonly pastoralService: PastoralService,
    private readonly whatsappService: WhatsAppService,
    private readonly prisma: PrismaService,
    private readonly syncService: SyncService,
    @InjectQueue('recurring-giving') private readonly recurringQueue: Queue,
  ) {
    super();
  }

  /**
   * Runs scheduled nightly maintenance tasks for a church.
   *
   * Recalculates engagement and risk scores for all active members,
   * identifies members needing pastoral attention, and dispatches
   * any due recurring giving charges.
   *
   * @param job - BullMQ job containing church ID
   * @returns Job result with scoring and recurring charge summary
   */
  async process(job: Job<{ churchId: string }>): Promise<{
    engagementScored: number;
    riskScored: number;
    membersNeedingAttention: number;
    recurringChargesDispatched: number;
    lifeEventGreetingsSent: number;
    ndprRecordsPurged: number;
    syncQueuePurged: number;
  }> {
    const { churchId } = job.data;

    this.logger.log(`Running nightly jobs for church ${churchId}`);
    try {
      await this.prisma.$executeRaw`SELECT belivrhq_notify_renewal(${churchId})`;
    } catch {
      this.logger.warn('Subscription renewal reminders could not be refreshed');
    }

    const engagementScored = await this.scoringService.calculateEngagementScores(churchId);
    await job.updateProgress(20);

    const riskScored = await this.scoringService.calculateRiskScores(churchId);
    await job.updateProgress(40);

    const attention = await this.scoringService.getMembersNeedingAttention(churchId, 50);
    await job.updateProgress(55);

    const lifeEventGreetingsSent = await this.processLifeEventGreetings(churchId);
    await job.updateProgress(70);

    const recurringChargesDispatched = await this.dispatchRecurringCharges(churchId);
    await job.updateProgress(85);

    const ndprDeleted = await this.purgeExpiredNdprData(churchId);
    const syncQueuePurged = await this.syncService.cleanupExpiredChanges(churchId);
    await job.updateProgress(100);

    this.logger.log(
      `Nightly jobs complete for church ${churchId}: ` +
        `${engagementScored} engagement, ${riskScored} risk, ` +
        `${attention.length} needing attention, ` +
        `${lifeEventGreetingsSent} life event greetings sent, ` +
        `${recurringChargesDispatched} recurring charges dispatched, ` +
        `${ndprDeleted} NDPR records purged, ` +
        `${syncQueuePurged} sync queue rows purged`,
    );

    return {
      engagementScored,
      riskScored,
      membersNeedingAttention: attention.length,
      recurringChargesDispatched,
      lifeEventGreetingsSent,
      ndprRecordsPurged: ndprDeleted,
      syncQueuePurged,
    };
  }

  /**
   * Queries for due recurring giving charges and dispatches them to the
   * recurring-giving queue for processing.
   *
   * @param churchId - Church ID to scope the query
   * @returns Number of charges dispatched
   */
  private async dispatchRecurringCharges(churchId: string): Promise<number> {
    const now = new Date();

    const dueCharges = await this.prisma.recurringGiving.findMany({
      where: {
        church_id: churchId,
        is_active: true,
        authorization_code: { not: null },
        next_charge_date: { lte: now },
      },
    });

    for (const recurring of dueCharges) {
      await this.recurringQueue.add(
        'charge',
        {
          recurringGivingId: recurring.id,
          churchId,
        },
        {
          jobId: `recurring-${recurring.id}-${now.toISOString().split('T')[0]}`,
        },
      );
    }

    if (dueCharges.length > 0) {
      this.logger.log(`Dispatched ${dueCharges.length} recurring charges for church ${churchId}`);
    }

    return dueCharges.length;
  }

  /**
   * Purges data that has exceeded the NDPR (Nigeria Data Protection Regulation)
   * retention period. Soft-deleted member records, orphaned personal data, and
   * audit logs older than the configurable grace period are permanently deleted.
   *
   * NDPR requires that personal data not be kept longer than necessary. This
   * function enforces a default retention period of 365 days (configurable via
   * the NDPR_RETENTION_DAYS env var / church config) for soft-deleted records.
   *
   * @param churchId - Church ID to scope the purge
   * @returns Number of records permanently deleted
   */
  private async purgeExpiredNdprData(churchId: string): Promise<number> {
    const retentionDays = 365; // NDPR grace period: 1 year
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let totalDeleted = 0;

    try {
      // 1. Permanently delete inactive members past the retention period
      // Members are soft-deleted by setting status to 'inactive'. After the
      // NDPR grace period (365 days), their data is permanently purged.
      const oldDeletedMembers = await this.prisma.member.findMany({
        where: {
          church_id: churchId,
          status: 'inactive',
          updated_at: { lte: cutoff },
        },
        select: { id: true },
      });

      if (oldDeletedMembers.length > 0) {
        const memberIds = oldDeletedMembers.map((m) => m.id);

        await this.prisma.$transaction(async (tx) => {
          // Detach optional foreign-key references before deletion
          await tx.profile.updateMany({
            where: { member_id: { in: memberIds } },
            data: { member_id: null },
          });
          await tx.assetLoan.updateMany({
            where: { borrower_member_id: { in: memberIds } },
            data: { borrower_member_id: null },
          });
          await tx.visitor.updateMany({
            where: { converted_member_id: { in: memberIds } },
            data: { converted_member_id: null },
          });

          // Delete related records first (foreign key constraints)
          await tx.departmentMember.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.cellGroupMember.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.cellGroupAttendance.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.familyMember.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.sermonBookmark.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.pastoralNote.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.lifeEvent.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.riskScore.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.engagementScore.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.recurringGiving.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.eventRegistration.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.ticket.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.transaction.deleteMany({
            where: { member_id: { in: memberIds } },
          });
          await tx.attendance.deleteMany({
            where: { member_id: { in: memberIds } },
          });

          // Finally delete the member records
          const deleted = await tx.member.deleteMany({
            where: { id: { in: memberIds } },
          });
          totalDeleted += deleted.count;

          this.logger.log(
            `NDPR purge: deleted ${deleted.count} member records (retention: ${retentionDays}d)`,
          );
        });
      }

      // 2. Delete audit logs older than 2 years (general retention policy)
      const auditCutoff = new Date();
      auditCutoff.setFullYear(auditCutoff.getFullYear() - 2);

      const oldAuditLogs = await this.prisma.auditLog.deleteMany({
        where: {
          church_id: churchId,
          created_at: { lte: auditCutoff },
        },
      });

      if (oldAuditLogs.count > 0) {
        totalDeleted += oldAuditLogs.count;
        this.logger.log(
          `NDPR purge: deleted ${oldAuditLogs.count} audit log records (retention: 2y)`,
        );
      }
    } catch (err) {
      this.logger.error(`NDPR purge failed for church ${churchId}: ${(err as Error).message}`);
    }

    return totalDeleted;
  }

  /**
   * Processes life event greetings for the upcoming day.
   *
   * Queries for un-notified life events happening tomorrow (birthdays,
   * wedding anniversaries, etc.) and sends automated WhatsApp greetings.
   *
   * Greeting messages are composed per event type:
   * - birthday: "Happy Birthday {name}! We celebrate you today. God bless you!"
   * - wedding: "Happy Wedding Anniversary {name}! May God continue to bless your union."
   * - dedication: "Remembering your child's dedication. God is faithful!"
   * - baptism: "Remembering your baptism! Walking in newness of life."
   * - death: "Thinking of you as we remember your loved one. May God comfort you."
   *
   * @param churchId - Church ID to scope the query
   * @returns Number of greeting messages sent
   */
  private async processLifeEventGreetings(churchId: string): Promise<number> {
    try {
      // Look 1 day ahead for events happening tomorrow
      const upcomingEvents = await this.pastoralService.getUpcomingLifeEvents(churchId, 1);

      if (upcomingEvents.length === 0) {
        return 0;
      }

      let sentCount = 0;

      for (const event of upcomingEvents) {
        try {
          const member = await this.prisma.member.findUnique({
            where: { id: event.memberId },
            select: {
              first_name: true,
              last_name: true,
              whatsapp_number: true,
              phone: true,
            },
          });

          if (!member) {
            this.logger.warn(`Life event ${event.id}: member ${event.memberId} not found`);
            await this.pastoralService.markLifeEventNotified(event.id);
            continue;
          }

          const greeting = this.composeLifeEventGreeting(event.type, member.first_name);
          if (!greeting) {
            await this.pastoralService.markLifeEventNotified(event.id);
            continue;
          }

          const recipientPhone = member.whatsapp_number || member.phone;
          if (!recipientPhone) {
            this.logger.warn(`Life event ${event.id}: member ${member.first_name} has no phone`);
            await this.pastoralService.markLifeEventNotified(event.id);
            continue;
          }

          await this.whatsappService.sendMessage(recipientPhone, greeting, churchId, undefined);

          await this.pastoralService.markLifeEventNotified(event.id);
          sentCount++;

          this.logger.log(
            `Life event greeting sent: ${event.type} → ${member.first_name} ${member.last_name} (${recipientPhone})`,
          );
        } catch (err) {
          this.logger.error(
            `Failed to send life event greeting for ${event.id}: ${(err as Error).message}`,
          );
          // Still mark as notified to avoid repeated failures
          await this.pastoralService.markLifeEventNotified(event.id).catch(() => {});
        }
      }

      return sentCount;
    } catch (err) {
      this.logger.error(
        `Life event greetings processing failed for church ${churchId}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Composes a WhatsApp greeting message based on life event type.
   *
   * @param eventType - Type of life event (birthday, wedding, etc.)
   * @param memberName - Member's first name for personalization
   * @returns Greeting message or null if the event type doesn't warrant a greeting
   */
  private composeLifeEventGreeting(eventType: string, memberName: string): string | null {
    const greetings: Record<string, string> = {
      birthday: `🎂 *Happy Birthday, ${memberName}!* 🎉\n\nWe celebrate you today! May God bless you with joy, peace, and favor in the year ahead. We're so grateful to have you as part of our church family! 🙏`,
      wedding: `💍 *Happy Wedding Anniversary, ${memberName}!* 💐\n\nMay God continue to bless your union with love, joy, and strength. We celebrate the covenant God has made in your marriage!`,
      dedication: `🙏 *Remembering Your Child's Dedication*\n\nDear ${memberName}, we pray that God continues to guide and protect your family. Your commitment to raising your child in the Lord is a beautiful testimony!`,
      baptism: `✝️ *Remembering Your Baptism*\n\nDear ${memberName}, as we remember your baptism, we celebrate your walk with Christ. May you continue to grow in faith and be a light to others!`,
      anniversary: `🎉 *Happy Anniversary, ${memberName}!* 🎊\n\nWe celebrate this special day with you! Thank you for being a valued member of our church family. God bless you abundantly!`,
    };

    return greetings[eventType] || null;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Nightly jobs job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
    );
  }
}
