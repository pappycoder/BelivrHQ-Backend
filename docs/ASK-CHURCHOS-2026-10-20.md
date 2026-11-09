# Ask BelivrHQ — first release

Ask BelivrHQ is a guidance-only dashboard side panel for active, verified staff. Its header entry is separate from Help Centre and human Tawk support. It explains product workflows and the current page, summarizes the user’s own verified roles/grant counts, cites product references, offers authorized static navigation links, and explains verified permission/plan restrictions. It cannot read church business records, inspect rendered screen content, check a selected record's state/ownership, perform actions or contact anyone. No new staff grants, database tables or migrations are required.

## What the user sees

Open **Ask BelivrHQ** in the workspace header. The panel shows the current normalized page and branch-scope description, suggested questions, a question composer, answers, reference links and expandable access checks. Examples include “Explain this page”, “How do I approve form submissions?” and “How do table display controls work?”. Enter submits; Shift+Enter inserts a new line. New conversation clears the current conversation and cancels a pending answer. Errors preserve the question for retry. Escape closes the panel. It supports narrow screens and keyboard focus through the shared Sheet primitive.

Reference mode works without an AI key. It is labelled **BelivrHQ references** and displays retrieved, reviewed product material and deterministic access checks. When configured and an active subscription is present, AI mode synthesizes selected references into concise answers. Access/role/permission questions remain deterministic regardless of provider configuration. AI mode explains that typed questions and selected product guidance go to OpenAI; users should keep questions general and omit passwords, secrets and personal records. Answers lead with a direct response, normally one to three sentences or up to three short steps, targeting fewer than 75 words. Reference answers are capped at 75 words; oversized model answers fall back to concise references. Detailed access checks remain expandable. Tawk remains the administrator-only human-support channel. Opening Ask BelivrHQ temporarily hides the Tawk widget and its error panel; closing the drawer restores the widget only while its authorized support session remains active. This preserves the conversation, covers delayed widget initialization and does not restore chat after logout.

Conversations remain in component memory, bounded to 20 turns. They are not stored in browser storage, the application database or shared query cache. Identity, branch, HQ, role, permissions and plan-feature changes remount the panel, clear the conversation and abort requests. Logout, inactive accounts and failed permission verification remove the entry. The panel never mounts on public landing/help/token-form pages. Only normalized route templates are sent, never actual record IDs, query strings, selected filters, form values or DOM contents. User text is nevertheless user-supplied: it can contain sensitive data if the user types it, which the UI explicitly discourages.

## Server boundary

Authenticated endpoints are `GET /assistant/context` and `POST /assistant/message`. Existing JWT/MFA/revocation validation and verified profile hydration still apply. They require an active, non-archived staff profile/church and a resolved permission list. The DTO accepts only question (max 1200 characters), normalized page template, and at most three previous user questions (600 characters each). Unknown tenant, role, permission, system-message or record-context fields are rejected. Current subscription lookup always uses the authenticated profile's church ID.

Guidance remains available to active staff of unpaid/expired churches, so they can understand access and renewal restrictions. Only the two exact assistant paths are exempt from subscription redirection. Such accounts receive reference mode; they cannot make paid AI calls. Other API routes retain their existing subscription enforcement. The assistant's conversational POST does not invalidate business-data caches or emit the frontend business-usage change event.

Navigation uses generated copies of the existing route and feature maps, current verified grants, additional all-of rules, administrator-only surfaces and subscription eligibility. Unknown/template/external links are never offered as actionable navigation. The frontend independently rechecks navigation against its current grants. Historical reads and feature eligibility are explained separately from write authority. HQ never becomes an implicit administrator grant. Specific record status, ownership, leadership assignment and current usage are explicitly unverified; those APIs are not called.

Knowledge comes from 20 public guides, 73 navigation entries, 11 reviewed detailed product policies and the generated permission catalog. Retrieval is local lexical ranking with page context and guide keywords; there is no vector database or whole-codebase upload. This is a bounded first release, not a claim of exhaustive or perfect knowledge of every BelivrHQ screen. The handwritten policies cover role/scope semantics, review/bulk flows, table controls, billing, historical access, attendance totals, giving, providers, support and offline limitations. Policy citations identify a BelivrHQ product reference rather than linking to an unrelated public article.

## Optional model configuration

Set these on the **backend only** (see `.env.example`):

- `OPENAI_API_KEY`: an organization-controlled API key with appropriately restricted project access.
- `ASK_BELIVRHQ_AI_ENABLED=true`: explicit opt-in to paid calls.
- `ASK_BELIVRHQ_MODEL`: a Responses API text model supporting strict structured output. No model is silently selected.
- `ASK_BELIVRHQ_INPUT_USD_PER_MILLION` and `ASK_BELIVRHQ_OUTPUT_USD_PER_MILLION`: the selected model's current regular input/output USD rates per million tokens. Missing/nonpositive/invalid rates keep reference mode active.
- `ASK_BELIVRHQ_CHURCH_DAILY_USD` (default 0.25), `ASK_BELIVRHQ_GLOBAL_DAILY_USD` (default 2), and `ASK_BELIVRHQ_GLOBAL_DAILY_REQUESTS` (default 2000).

The Responses integration uses a fixed official endpoint, `store: false`, strict structured output, no tools, a 20-second timeout and at most 450 output tokens. The model receives selected public/product references, bounded user text and minimal access conclusions; server-added names, email, identity IDs, raw permission arrays, church records and credentials are excluded. Output must cite supplied source IDs and pass size/shape/link/content checks. Provider errors, refusals, incomplete/malformed answers and unverified citations fall back to reference guidance. No automatic provider retry occurs.

`store: false` disables Responses application-state storage; it does **not** by itself guarantee zero provider retention. Review the provider's current data policy and account controls before production activation. No actual model key, rates or paid calls were configured or exercised by this implementation.

## Usage and cost controls

AI synthesis requires one atomic Redis reservation spanning the user, church, platform request counter and church/platform estimated-cost counters. Default pilot daily request allowances are 30 per user, and 20/50/100/200 per church for Essentials/Community/Network/Enterprise, subject to the platform and estimated-spend caps. They are internal pilot limits, not a change to advertised subscription entitlements. Keys roll over at midnight Africa/Lagos and expire automatically. The conversational endpoint also has an authenticated 10-per-minute rate limit. Ordinary reference answers consume no AI budget.

Cost reservations conservatively bound input using UTF-8 bytes plus framing allowance and reserve the full maximum output at the configured regular model rates. Client cancellation does not guarantee upstream cancellation. Reservations are kept even after timeout/failure, preventing uncertain requests from freeing funds for duplicate calls. Cached-input discounts are not assumed. Redis denial/outage prevents model calls; references remain available. These are application **estimated-cost** guards, not a provider billing guarantee. Maintain correct rates when changing models, and set vendor project limits/alerts as well. No customer payment or automatic plan price change is introduced.

## Keeping knowledge current

Run from BelivrHQ-Web:

```
npm run assistant:sync
npm run assistant:check
```

The sync script reads the web help content/catalog, navigation AST, route map, feature map, reviewed policies and sibling backend permission seed. It writes versioned standalone TypeScript artifacts into `BelivrHQ-Backend/src/assistant`. The hash changes with the consumed material. Check mode fails if generated files are stale. Commit both repositories' changes together and run the check during coordinated release verification. Backend deployment/build uses checked-in artifacts and does not require a sibling frontend checkout. Generated artifacts skip only formatting lint; normal compilation and other lint checks still apply.

Update policies when behavior, permissions, plan semantics or UI labels change. Run boundary tests across branch/HQ/custom roles, plans, denied actions and historical reads. The backend remains the authority; prompt instructions do not enforce authorization.

Deploy backend and web together. API key/model configuration and provider billing controls are operational setup, not frontend settings. No live deployment, support conversation, email, business mutation or paid model call has been performed.

## Concise-answer and chat-visibility verification

The brevity and widget-suppression update passes 42 assistant backend unit tests and 35 browser checks across the assistant and support suites. These cover short reference output, rejection of oversized model output, temporary hiding without ending a chat, delayed widget initialization and preventing restoration after session end. Backend/web production builds, scoped lint/type checks, generated-knowledge drift check and diff whitespace checks pass. Provider and Tawk browser behavior are mocked; no paid call or live support conversation was created.

## References

- [OpenAI Docs: text generation](https://developers.openai.com/api/docs/guides/text)
- [OpenAI Docs: structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)
