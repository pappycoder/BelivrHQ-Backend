import * as ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Public routes, self-service, and resource-specific permission/ownership checks
// cannot be described as one static ALL-permissions requirement. New exceptions
// must be reviewed here rather than silently bypassing the global guard.
const exceptions: Record<string, string[]> = {
  // Every method verifies the signed, expiring, billing-only signup capability and tenant/profile ownership.
  'billing/registration-billing.controller.ts': ['status', 'quote', 'checkout', 'verify', 'close'],
  // Public links are token scoped. Private methods use kind-dependent register
  // grants plus tenant/branch scope in IntakeService (covered by intake tests).
  'intake/intake.controller.ts': ['meta', 'submit', 'link', 'list', 'detail', 'accept', 'reject'],
  // Action-scoped challenge issuance reads no business data; private issuance requires JWT.
  'bot-protection/bot-protection.controller.ts': ['challenge', 'authenticatedChallenge'],
  // Self-service product guidance only: JWT plus AssistantService active staff/church checks.
  // No business-record reads/actions; grants, scope and plan are resolved from the verified profile.
  'assistant/assistant.controller.ts': ['context', 'ask'],
  // Provider signatures plus server verification authenticate subscription callbacks.
  'billing/billing.controller.ts': ['webhook', 'catalog'],
  'auth/auth.controller.ts': [
    'session',
    'register',
    'login',
    'completeTwoFactorLogin',
    'logout',
    'forgotPassword',
    'resetPassword',
    'changePassword',
    'refreshSession',
    // One-time invitation token plus rate limiting; no existing account session.
    'acceptInvitation',
  ],
  'common/audit-logs.controller.ts': ['listMyLogs'],
  'custom-fields/custom-fields.controller.ts': ['findAll', 'findOne'],
  'developer-guide/developer-guide.controller.ts': ['getGuide'],
  'events/event-webhooks.controller.ts': ['handlePaystackWebhook'],
  'events/events.controller.ts': ['getEvent', 'listTicketTiers', 'registerForEvent'],
  'forms/forms-public.controller.ts': ['getPublicFormMeta', 'submitPublicForm'],
  'forms/forms.controller.ts': ['listForms', 'getForm', 'submitForm'],
  'giving/giving.controller.ts': [
    'initializePayment',
    'verifyPayment',
    'handlePaystackWebhook',
    'handleFlutterwaveWebhook',
  ],
  'health/health.controller.ts': ['check'],
  // Upload services enforce folder-specific grants, branch/plan scope and signed completion tickets.
  'media/media.controller.ts': [
    'file',
    'uploadImage',
    'uploadFile',
    'prepareUpload',
    'completeUpload',
  ],
  'members/members.controller.ts': [
    'findAll',
    'search',
    'exportCsv',
    'exportXlsx',
    'findOne',
    'generateQRCode',
    'getGivingHistory',
    'getAttendanceHistory',
  ],
  'notifications/notifications.controller.ts': [
    'listNotifications',
    'getUnreadCount',
    'bulkMarkAsRead',
    'bulkMarkAsUnread',
    'bulkRemove',
    'getOne',
    'markAsRead',
    'markAllAsRead',
    'remove',
  ],
  'profile/profile.controller.ts': [
    'getMe',
    'updateMe',
    'uploadPhoto',
    'listFactors',
    'setupAuthenticator',
    'enableTwoFactor',
    'disableTwoFactor',
    'regenerateRecoveryCodes',
  ],
  'sermons/sermons.controller.ts': [
    'listMyBookmarks',
    'addBookmark',
    'removeBookmark',
    'checkBookmark',
  ],
  'sync/offline.controller.ts': ['snapshot', 'push'],
  'sync/sync.controller.ts': ['pushChanges', 'bootstrap', 'pullChanges', 'markSynced'],
  'integrations/integration-callbacks.controller.ts': ['verify', 'receive'],
  'integrations/payment-callbacks.controller.ts': ['receive'],
};
const publicRoutes = new Set([
  'billing/registration-billing.controller.ts:status',
  'billing/registration-billing.controller.ts:quote',
  'billing/registration-billing.controller.ts:checkout',
  'billing/registration-billing.controller.ts:verify',
  'billing/registration-billing.controller.ts:close',
  'intake/intake.controller.ts:meta',
  'intake/intake.controller.ts:submit',
  'bot-protection/bot-protection.controller.ts:challenge',
  // Public server-owned subscription prices; no church or payment history.
  'billing/billing.controller.ts:catalog',
  'billing/billing.controller.ts:webhook',
  'integrations/integration-callbacks.controller.ts:verify',
  'integrations/integration-callbacks.controller.ts:receive',
  'integrations/payment-callbacks.controller.ts:receive',
  'auth/auth.controller.ts:register',
  'auth/auth.controller.ts:login',
  'auth/auth.controller.ts:completeTwoFactorLogin',
  'auth/auth.controller.ts:forgotPassword',
  'auth/auth.controller.ts:resetPassword',
  'auth/auth.controller.ts:refreshSession',
  'auth/auth.controller.ts:acceptInvitation',
  'developer-guide/developer-guide.controller.ts:getGuide',
  'events/event-webhooks.controller.ts:handlePaystackWebhook',
  'forms/forms-public.controller.ts:getPublicFormMeta',
  'forms/forms-public.controller.ts:submitPublicForm',
  'health/health.controller.ts:check',
  'giving/giving.controller.ts:handlePaystackWebhook',
  'giving/giving.controller.ts:handleFlutterwaveWebhook',
  // Church-specific callbacks authenticate with provider signatures/subscription tokens.
]);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.controller.ts') ? [path] : [];
  });
}

describe('API authorization coverage', () => {
  it('requires a permission policy or an explicit exception, and JWT authentication on every private route', () => {
    const root = join(__dirname, '../../../src');
    const violations: string[] = [];
    for (const file of files(root)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const decorators = (node: ts.Node) =>
        ts.canHaveDecorators(node)
          ? (ts.getDecorators(node) ?? []).map((d) => d.expression.getText(source))
          : [];
      const path = relative(root, file);
      for (const node of source.statements) {
        if (!ts.isClassDeclaration(node)) continue;
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const methodDecorators = decorators(member);
          if (!methodDecorators.some((d) => /^(Get|Post|Put|Patch|Delete)\(/.test(d))) continue;
          const all = [...methodDecorators, ...decorators(node)];
          const name = member.name.getText(source);
          const key = `${path}:${name}`;
          if (
            !all.some((d) => d.startsWith('RequirePermissions(')) &&
            !exceptions[path]?.includes(name)
          )
            violations.push(`${key}: missing authorization policy`);
          if (
            !publicRoutes.has(key) &&
            !all.some((d) => d.startsWith('UseGuards(') && d.includes('JwtAuthGuard'))
          )
            violations.push(`${key}: missing authentication`);
          if (all.some((d) => d.includes('RolesGuard') || d.startsWith('RequireRoles(')))
            violations.push(`${key}: legacy role guard`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
