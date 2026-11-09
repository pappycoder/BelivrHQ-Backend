import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { churchEntitlements } from '../billing/entitlements';
import { AssistantProvider } from './assistant.provider';
import { AssistantBudget, requestLimit } from './assistant.budget';
import {
  actionAccess,
  KNOWLEDGE_VERSION,
  normalizedPage,
  pageSummary,
  retrieve,
  routeAccess,
} from './assistant.knowledge';
import type { AccessContext } from './assistant.knowledge';
import type {
  AssistantAccess,
  AssistantReply,
  AssistantSource,
  StaffProfile,
} from './assistant.types';
import type { AssistantQuestionDto } from './assistant.dto';

/** Extract a short, relevant reference answer instead of dumping full guide sections. */
export function conciseReference(source: AssistantSource | undefined, question: string): string {
  if (!source)
    return 'I could not find a reliable BelivrHQ answer. Try a specific feature or open the Help Centre.';
  const words = [...new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter(
    (word) =>
      ![
        'what',
        'does',
        'this',
        'that',
        'with',
        'from',
        'your',
        'have',
        'work',
        'works',
        'explain',
        'belivrhq',
      ].includes(word),
  );
  const sentences = source.text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((text, index) => ({ text: text.trim(), index }))
    .filter((item) => item.text.split(/\s+/).length >= 6);
  const selected = sentences
    .map((item) => ({
      ...item,
      score: words.reduce((sum, word) => sum + (item.text.toLowerCase().includes(word) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text)
    .join(' ');
  const answer = (selected || source.text).split(/\s+/).slice(0, 75).join(' ');
  return /[.!?]$/.test(answer) ? answer : `${answer.replace(/[,;:]$/, '')}…`;
}
function conciseAccess(item: AssistantAccess | undefined, reviewing: boolean): string {
  if (!item) return 'Ask about a specific BelivrHQ feature so I can check its access requirements.';
  switch (item.status) {
    case 'missing_permission':
      return reviewing
        ? 'Your account does not have submission review permission. Ask your church administrator to enable it.'
        : 'Your current permissions do not allow this page or action. Ask your church administrator to review your access.';
    case 'admin_required':
      return 'This feature is restricted to church administrators and super administrators. HQ access alone does not enable it.';
    case 'plan_required':
      return 'Your church plan does not currently enable this feature. Ask your church administrator to review the plan; existing records are retained until an eligible plan enables access again.';
    case 'subscription_required':
      return 'Your church subscription is not active. Your church administrator can review Plan & Billing.';
    case 'available':
      return reviewing
        ? 'You have submission review permission. Only pending responses within your authorized scope can be reviewed.'
        : 'You have the required page or action grant. Branch, record ownership and status checks still apply.';
  }
}

@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AssistantProvider,
    private readonly budget: AssistantBudget,
  ) {}
  private async verified(profile?: StaffProfile): Promise<AccessContext> {
    if (
      !profile ||
      profile.status !== 'active' ||
      !profile.roles?.length ||
      profile.profile_archived_at ||
      profile.church_archived_at ||
      !profile.church_id ||
      !Array.isArray(profile.permissions)
    )
      throw new ForbiddenException('An active verified staff profile is required.');
    const entitlement = await churchEntitlements(this.prisma, profile.church_id);
    return {
      profile,
      features: entitlement.features,
      plan: entitlement.plan,
      subscriptionActive: entitlement.active,
    };
  }
  async context(profile?: StaffProfile) {
    const context = await this.verified(profile);
    return {
      mode: this.provider.configured && context.subscriptionActive ? 'ai' : 'guides',
      knowledgeVersion: KNOWLEDGE_VERSION,
      scope: {
        roles: context.profile.roles,
        location: context.profile.is_admin_hq
          ? 'All authorized branches'
          : context.profile.branch_id
            ? 'Your assigned branch'
            : 'No branch assigned',
        plan: context.plan,
        subscriptionActive: context.subscriptionActive,
      },
      limits: {
        churchDailyQuestions: requestLimit(context.plan),
        userDailyQuestions: 30,
        resetTimezone: 'Africa/Lagos',
      },
    };
  }
  async ask(dto: AssistantQuestionDto, profile?: StaffProfile): Promise<AssistantReply> {
    const question = dto.question.trim();
    if (!question) throw new BadRequestException('Please enter a question.');
    const context = await this.verified(profile);
    const page = normalizedPage(dto.page);
    const history = (dto.history ?? []).slice(-3);
    const found = retrieve(question, page, history);
    const current = pageSummary(page);
    const routes = [
      ...new Map(
        [
          ...found.routes,
          ...(/this page|this screen|my access/i.test(question) ? [current] : []),
        ].map((item) => [item.path, item]),
      ).values(),
    ];
    const access = [
      ...routes.map((item) => routeAccess(item.path, context)),
      ...actionAccess(question, page, context),
    ];
    const navigation = routes
      .filter(
        (item) =>
          !item.path.includes('[') && routeAccess(item.path, context).status === 'available',
      )
      .slice(0, 4);
    const permissionsQuestion =
      /permission|access|role|admin|hq|cannot|can['’]t|allowed|denied|^(?:can i|am i|do i have)|why.*(?:see|approve|reject|edit)|[a-z_]+:[a-z_-]+/i.test(
        question,
      );
    const sources = found.sources.slice(0, 5);
    const reviewing = /approv|reject|review.*(?:form|response|submission)/i.test(question);
    const primaryAccess = reviewing
      ? access.find((item) => item.label === 'forms:submissions:update')
      : /this page|this screen|my access/i.test(question)
        ? routeAccess(page, context)
        : (access.find((item) => item.status !== 'available') ?? access[0]);
    const reference = conciseReference(sources[0], question);
    const fallback = permissionsQuestion
      ? conciseAccess(primaryAccess, reviewing)
      : /explain this page|this screen|where am i/i.test(question)
        ? `You are on ${current.trail}. ${sources.length ? reference : 'Ask about a task on this page for specific steps.'}`
        : reference;
    const ownOverview =
      /my permissions|my roles|what (?:access|permissions) do i have|list (?:all )?my (?:access|permissions)/i.test(
        question,
      );
    const granted = [...new Set(context.profile.permissions ?? [])].sort();
    const resources = new Set(granted.map((code) => code.split(':')[0]));
    const overview = `Your roles: ${(context.profile.roles ?? []).join(', ')}. You hold ${granted.length} effective permission grants across ${resources.size} ${resources.size === 1 ? 'area' : 'areas'}, scoped to ${context.profile.is_admin_hq ? 'authorized HQ branches' : context.profile.branch_id ? 'your assigned branch' : 'no assigned branch'}. Ask about a specific feature for its exact checks.`;
    const base: AssistantReply = {
      answer: ownOverview ? overview : fallback,
      mode: 'guides',
      sources: sources.map(({ id, title, path }) => ({ id, title, path })),
      navigation,
      access,
      knowledgeVersion: KNOWLEDGE_VERSION,
    };
    // Deterministic access answers cannot be overridden by model or user instructions.
    if (
      permissionsQuestion ||
      !sources.length ||
      !this.provider.configured ||
      !context.subscriptionActive
    )
      return base;
    // Server-added context omits identity IDs, names, email, full permission lists and records.
    // Questions/history remain user-supplied text, as disclosed in the panel.
    const verifiedFacts = {
      page: current,
      plan: context.plan,
      subscriptionActive: context.subscriptionActive,
      branchScope: context.profile.is_admin_hq ? 'authorized HQ scope' : 'assigned branch only',
      access,
    };
    const body = this.provider.request(
      question,
      history,
      verifiedFacts,
      sources.map((source) => ({ ...source, text: source.text.slice(0, 4500) })),
    );
    const reserved = await this.budget.reserve(
      context.profile.church_id,
      context.profile.id,
      context.plan,
      this.provider.reserveCost(body),
    );
    if (!reserved)
      return {
        ...base,
        notice: 'AI is unavailable or its daily allowance is reached. Showing reference guidance.',
      };
    try {
      const answer = await this.provider.answer(body, sources);
      return {
        ...base,
        mode: 'ai',
        answer: answer.answer,
        sources: base.sources.filter((source) => answer.sourceIds.includes(source.id)),
      };
    } catch {
      return {
        ...base,
        notice: 'AI is temporarily unavailable. Showing reference guidance.',
      };
    }
  }
}
