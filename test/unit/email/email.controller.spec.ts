/**
 * @file email.controller.spec.ts
 * @description Source-scan regression guards for EmailController.
 *
 * Asserts every email route carries the correct `@RequirePermissions` and that
 * the literal routes (contacts, unread-count) are declared before the
 * `:messageId` param route to avoid Express shadowing. Asserted against source
 * text to avoid pulling the controller's transitive ESM-only deps into Jest.
 */

import * as fs from 'fs';
import * as path from 'path';

const EMAIL_CONTROLLER_PATH = path.join(__dirname, '../../../src/email/email.controller.ts');

describe('EmailController permission decorators + route order', () => {
  const source = fs.readFileSync(EMAIL_CONTROLLER_PATH, 'utf8');

  const blockBetween = (start: string, end: string): string => {
    const startIdx = source.indexOf(start);
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = source.indexOf(end, startIdx);
    expect(endIdx).toBeGreaterThan(-1);
    return source.slice(startIdx, endIdx);
  };

  const controllerIsGuarded =
    source.includes('@UseGuards(JwtAuthGuard)') && source.includes("@Controller('email')");

  it('controller is auth-guarded under /email', () => {
    expect(controllerIsGuarded).toBe(true);
  });

  it('lists contacts under GET /email/contacts (emails:read)', () => {
    const block = blockBetween("@Get('contacts')", 'async listContacts(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('returns unread count under GET /email/unread-count (emails:read)', () => {
    const block = blockBetween("@Get('unread-count')", 'async getUnreadCount(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('lists emails under GET /email (emails:read)', () => {
    const block = blockBetween('@Get()', 'async list(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('sends under POST /email (emails:create)', () => {
    const block = blockBetween('@Post()', 'async send(');
    expect(block).toContain("@RequirePermissions('emails:create')");
  });

  it('reads a single email under GET /email/:messageId (emails:read)', () => {
    const block = blockBetween("@Get(':messageId')", 'async getOne(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('marks read under POST /email/:messageId/read (emails:read — self-scoped mailbox bookkeeping)', () => {
    const block = blockBetween("@Post(':messageId/read')", 'async markRead(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('marks unread under POST /email/:messageId/unread (emails:read — self-scoped mailbox bookkeeping)', () => {
    const block = blockBetween("@Post(':messageId/unread')", 'async markUnread(');
    expect(block).toContain("@RequirePermissions('emails:read')");
  });

  it('trashes under DELETE /email/:messageId (emails:delete)', () => {
    const block = blockBetween("@Delete(':messageId')", 'async trash(');
    expect(block).toContain("@RequirePermissions('emails:delete')");
  });

  it('restores under POST /email/:messageId/restore (emails:update)', () => {
    const block = blockBetween("@Post(':messageId/restore')", 'async restore(');
    expect(block).toContain("@RequirePermissions('emails:update')");
  });

  it('hard-deletes under DELETE /email/:messageId/permanent (emails:delete)', () => {
    const block = blockBetween("@Delete(':messageId/permanent')", 'async deleteForever(');
    expect(block).toContain("@RequirePermissions('emails:delete')");
  });

  it('declares contacts + unread-count before the :messageId param route', () => {
    const contactsIdx = source.indexOf("@Get('contacts')");
    const unreadIdx = source.indexOf("@Get('unread-count')");
    const paramIdx = source.indexOf("@Get(':messageId')");
    expect(contactsIdx).toBeGreaterThan(-1);
    expect(unreadIdx).toBeGreaterThan(-1);
    expect(paramIdx).toBeGreaterThan(-1);
    expect(contactsIdx).toBeLessThan(paramIdx);
    expect(unreadIdx).toBeLessThan(paramIdx);
  });
});
