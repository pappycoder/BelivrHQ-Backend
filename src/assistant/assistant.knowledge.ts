import { KNOWLEDGE, KNOWLEDGE_VERSION } from './knowledge.generated';
import {
  checkRule,
  featureForPath,
  featureForPermission,
  matchRoutePermission,
  ROUTE_PERMISSIONS,
} from './routes.generated';
import type { AssistantAccess, AssistantSource, StaffProfile } from './assistant.types';

export interface AccessContext {
  profile: StaffProfile;
  features: string[];
  plan: string;
  subscriptionActive: boolean;
}
export const isAdministrator = (profile: StaffProfile) =>
  (profile.roles ?? [profile.role]).some((role) => ['church_admin', 'super_admin'].includes(role));
const adminOnly = (path: string) =>
  /^\/(analytics(?:\/|$)|admin\/integrations(?:\/|$)|subscription(?:\/|$))/.test(path);
export function routeAccess(path: string, context: AccessContext): AssistantAccess {
  const rule = matchRoutePermission(path);
  const label =
    KNOWLEDGE.navigation.find((item) => item.path === path)?.trail ??
    rule?.prefix ??
    'Unknown page';
  if (adminOnly(path) && !isAdministrator(context.profile))
    return {
      label,
      status: 'admin_required',
      detail:
        'This surface is reserved for church administrators and super administrators; HQ status alone does not grant it.',
    };
  const permissions = new Set(context.profile.permissions ?? []);
  if (!checkRule(rule, (code) => permissions.has(code)))
    return {
      label,
      status: 'missing_permission',
      detail: `Your verified grants do not satisfy this page rule. Required: ${[rule?.permission, ...(rule?.anyOf ?? [])].filter(Boolean).join(' OR ') || 'a recognized route'}${rule?.allOf?.length ? `; also required: ${rule.allOf.join(', ')}` : ''}.`,
    };
  if (
    !context.subscriptionActive &&
    !['/help', '/profile', '/subscription', '/support'].includes(path)
  )
    return {
      label,
      status: 'subscription_required',
      detail:
        'Your church subscription is not active. Your church administrator can review Plan & Billing.',
    };
  const feature = featureForPath(path);
  if (feature && !context.features.includes(feature))
    return {
      label,
      status: 'plan_required',
      detail: `The ${feature} feature is outside your church plan. Reads and writes require an eligible active plan. Existing records are retained for when your church upgrades.`,
    };
  return {
    label,
    status: 'available',
    detail:
      path === '/support'
        ? 'You can open Contact support. Live Tawk chat is restricted to active church/super administrators.'
        : 'Your verified grants allow this page. Branch, record ownership/state and individual action checks still apply.',
  };
}
export function normalizedPage(page?: string) {
  const exact = ROUTE_PERMISSIONS.find((rule) => rule.prefix === page);
  return exact?.prefix ?? '/home';
}
export function pageSummary(page?: string) {
  const path = normalizedPage(page);
  const item = KNOWLEDGE.navigation.find((item) => item.path === path);
  return {
    path,
    title:
      item?.title ??
      path
        .split('/')
        .filter(Boolean)
        .map((part) => (/^\[/.test(part) ? 'Record' : part.replaceAll('-', ' ')))
        .join(' / '),
    trail: item?.trail ?? path,
  };
}
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'how',
  'can',
  'you',
  'your',
  'this',
  'that',
  'what',
  'where',
  'does',
  'please',
  'belivrhq',
  'have',
  'want',
  'need',
  'from',
  'into',
  'about',
  'why',
  'not',
  'are',
  'help',
  'tell',
  'explain',
  'work',
  'works',
  'system',
  'page',
  'screen',
  'make',
  'give',
  'show',
  'get',
  'use',
]);
const tokens = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (word) => word.length > 2 && !STOP.has(word),
  );
const score = (question: string[], title: string, text: string) =>
  question.reduce(
    (sum, word) =>
      sum + (title.toLowerCase().includes(word) ? 5 : text.toLowerCase().includes(word) ? 1 : 0),
    0,
  );
export function retrieve(question: string, page: string, history: string[] = []) {
  const words = tokens(`${question} ${history.slice(-2).join(' ')}`);
  const contextual = /this page|this screen|here|my access|my permissions/i.test(question);
  const relatedWords = contextual ? [...words, ...tokens(page)] : words;
  const sources: (AssistantSource & { keywords?: string[] })[] = KNOWLEDGE.guides.map((guide) => ({
    keywords: guide.keywords,
    id: `guide:${guide.slug}`,
    title: guide.title,
    path: guide.path,
    text: [
      guide.summary,
      ...guide.sections.flatMap((section) => [
        section.title,
        ...(section.paragraphs ?? []),
        ...(section.steps ?? []),
        ...(section.bullets ?? []),
        section.note ?? '',
      ]),
    ].join('\n'),
  }));
  sources.push(
    ...KNOWLEDGE.policies.map((policy) => ({
      id: `policy:${policy.id}`,
      title: policy.title,
      text: policy.text,
    })),
  );
  const ranked = sources
    .map((source) => ({
      source,
      score: score(
        relatedWords,
        `${source.title} ${(source.keywords ?? []).join(' ')}`,
        source.text,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const routes = KNOWLEDGE.navigation
    .filter((item) => !item.path.includes('['))
    .map((item) => ({ item, score: score(relatedWords, item.trail, item.path) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((entry) => entry.item);
  return { sources: ranked.map((item) => item.source), routes };
}
export function actionAccess(
  question: string,
  page: string,
  context: AccessContext,
): AssistantAccess[] {
  const exactCode = question.match(/\b[a-z_]+(?::[a-z_-]+){1,3}\b/)?.[0];
  const direct = KNOWLEDGE.permissions.find((permission) => permission.name === exactCode);
  const forms =
    /form|submission|approv|reject/i.test(question) ||
    (/^\/forms/.test(page) && /access|permission|this page/.test(question));
  const rules = retrieve(question, page).routes.map((route) => matchRoutePermission(route.path));
  if (/this page|this screen|my access|my permissions/i.test(question))
    rules.push(matchRoutePermission(page));
  const required = rules.flatMap((rule) =>
    [rule?.permission, ...(rule?.anyOf ?? []), ...(rule?.allOf ?? [])].filter(
      (code): code is string => !!code,
    ),
  );
  const resources = new Set(required.map((code) => code.split(':')[0]));
  const codes = direct
    ? [direct.name]
    : forms
      ? ['forms:list:read', 'forms:submissions:read', 'forms:submissions:update']
      : [
          ...new Set([
            ...required,
            ...(context.profile.permissions ?? []).filter((code) =>
              resources.has(code.split(':')[0]),
            ),
          ]),
        ].slice(0, 12);
  return codes.map((code) => {
    const held = context.profile.permissions?.includes(code);
    const feature = featureForPermission(code);
    const writable = !/:(read|view|delete)$/.test(code);
    const adminBlocked =
      /^(analytics|integrations|billing):/.test(code) && !isAdministrator(context.profile);
    const planBlocked =
      !context.subscriptionActive || (!!feature && !context.features.includes(feature));
    return {
      label: code,
      status: adminBlocked
        ? 'admin_required'
        : !held
          ? 'missing_permission'
          : planBlocked
            ? 'plan_required'
            : 'available',
      detail: adminBlocked
        ? 'This surface requires an administrator role as well as the applicable grants.'
        : !held
          ? 'This grant is absent from your current verified permissions.'
          : planBlocked
            ? 'This action requires an eligible active subscription as well as staff permission.'
            : writable
              ? 'You hold this action grant. Record ownership, branch scope and state checks still apply; those checks have not been performed here.'
              : 'You hold this read/view/delete grant. Record scope and state checks still apply; this grant does not authorize other operations.',
    };
  });
}
export { KNOWLEDGE_VERSION };
