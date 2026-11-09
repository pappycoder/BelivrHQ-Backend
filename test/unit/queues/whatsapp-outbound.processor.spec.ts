/**
 * @file whatsapp-outbound.processor.spec.ts
 * @description Unit tests for WhatsAppOutboundProcessor.
 *
 * Tests successful outbound WhatsApp processing and SMS fallback behavior.
 *
 * @module test/unit/queues/whatsapp-outbound.processor.spec
 * @since 1.0.0
 */

import { WhatsAppOutboundProcessor } from '../../../src/queues/processors/whatsapp-outbound.processor';
import { WhatsAppService } from '../../../src/whatsapp/whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { MessagingDeliveryService } from '../../../src/communication/messaging-delivery.service';
import { Job } from 'bullmq';

describe('WhatsAppOutboundProcessor', () => {
  let processor: WhatsAppOutboundProcessor;
  let whatsappService: { sendMessage: jest.Mock };
  let configService: { get: jest.Mock };
  let termiiService: { sendSms: jest.Mock };

  beforeEach(() => {
    whatsappService = { sendMessage: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(false) };
    termiiService = { sendSms: jest.fn().mockResolvedValue('sms-msg-id') };

    processor = new WhatsAppOutboundProcessor(
      whatsappService as unknown as WhatsAppService,
      configService as unknown as ConfigService,
      termiiService as unknown as MessagingDeliveryService,
    );
  });

  function createJob(overrides?: {
    attemptsMade?: number;
    attempts?: number;
    messageId?: string;
  }): {
    id: string;
    name: string;
    data: Record<string, unknown>;
    attemptsMade: number;
    opts: { attempts: number };
    updateData: jest.Mock;
  } {
    return {
      id: 'job-1',
      name: 'send',
      data: {
        to: '+2348012345678',
        message: 'Hello from BelivrHQ',
        churchId: 'church-1',
        memberId: 'member-1',
        ...(overrides?.messageId ? { messageId: overrides.messageId } : {}),
      },
      attemptsMade: overrides?.attemptsMade ?? 3,
      opts: { attempts: overrides?.attempts ?? 3 },
      updateData: jest.fn().mockResolvedValue(undefined),
    };
  }

  describe('process', () => {
    it('should send WhatsApp message and store message ID in job data', async () => {
      whatsappService.sendMessage.mockResolvedValue({ messageId: 'wa-msg-id' });

      const job = createJob({ attemptsMade: 0, attempts: 3 });
      await processor.process(job as unknown as Job);

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        '+2348012345678',
        'Hello from BelivrHQ',
        'church-1',
        'member-1',
      );
      expect(job.updateData).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'wa-msg-id' }),
      );
    });
  });

  describe('onFailed', () => {
    it('should send SMS fallback on final attempt when enabled', async () => {
      configService.get.mockReturnValue(true);

      const job = createJob({ messageId: 'wa-msg-id' });
      await processor.onFailed(job as unknown as Job, new Error('WhatsApp failed'));

      expect(termiiService.sendSms).toHaveBeenCalledWith(
        '+2348012345678',
        'Hello from BelivrHQ',
        'church-1',
        'wa-msg-id',
      );
    });

    it('should not send SMS fallback when disabled', async () => {
      configService.get.mockReturnValue(false);

      const job = createJob();
      await processor.onFailed(job as unknown as Job, new Error('WhatsApp failed'));

      expect(termiiService.sendSms).not.toHaveBeenCalled();
    });

    it.each(['false', '', undefined])(
      'keeps SMS fallback off for an environment value of %s',
      async (value) => {
        configService.get.mockReturnValue(value);
        await processor.onFailed(createJob() as unknown as Job, new Error('WhatsApp failed'));
        expect(termiiService.sendSms).not.toHaveBeenCalled();
      },
    );

    it('accepts an explicit true environment value for SMS fallback', async () => {
      configService.get.mockReturnValue('true');
      await processor.onFailed(createJob() as unknown as Job, new Error('WhatsApp failed'));
      expect(termiiService.sendSms).toHaveBeenCalledTimes(1);
    });

    it('should not send SMS fallback on non-final attempt', async () => {
      configService.get.mockReturnValue(true);

      const job = createJob({ attemptsMade: 1, attempts: 3 });
      await processor.onFailed(job as unknown as Job, new Error('WhatsApp failed'));

      expect(termiiService.sendSms).not.toHaveBeenCalled();
    });

    it('should swallow SMS fallback errors without throwing', async () => {
      configService.get.mockReturnValue(true);
      termiiService.sendSms.mockRejectedValue(new Error('Termii down'));

      const job = createJob();

      await expect(
        processor.onFailed(job as unknown as Job, new Error('WhatsApp failed')),
      ).resolves.toBeUndefined();
    });

    it('should skip SMS fallback for template jobs without a plain-text message', async () => {
      configService.get.mockReturnValue(true);

      const job = createJob();
      job.data = {
        to: '+2348012345678',
        templateName: 'welcome',
        language: 'en',
        variables: { name: 'John' },
        churchId: 'church-1',
      };

      await processor.onFailed(job as unknown as Job, new Error('WhatsApp failed'));

      expect(termiiService.sendSms).not.toHaveBeenCalled();
    });
  });
});
