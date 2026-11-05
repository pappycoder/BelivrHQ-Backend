# Form bot protection

ChurchOS uses self-hosted ALTCHA proof of work and a honeypot. Protected forms show an explicit verification checkbox. The browser loads the npm widget only on protected forms; challenge generation and verification stay in the existing NestJS API and Redis. No ALTCHA account or external CAPTCHA API is required.

## Protected requests

| Method | Path (under `/api/v1`) |
| --- | --- |
| POST | `/auth/register`, `/auth/login`, `/auth/login/2fa` |
| POST | `/auth/forgot-password`, `/auth/accept-invitation` |
| PATCH | `/auth/reset-password` |
| POST | `/forms/public/:publicToken/submit` |
| PUT | `/auth/password` |
| POST | `/profiles/invite`, `/church/invite` |
| POST | `/profiles/:profileId/reset-password` |
| POST | `/broadcasts` (immediate and scheduled) |

Routine record edits, authenticated form responses, token refresh, workers, provider callbacks and third-party support chat retain their existing controls. Password-reset emails still avoid account enumeration after verification succeeds. The administrator reset hook and alternate church invitation API are protected even where the current dashboard does not expose a caller.

## Request contract

Every protected JSON request must include top-level `altcha` (base64-encoded solved payload, at most 8,192 characters) and `website` (exactly an empty string). These fields are removed before normal DTO validation and never enter persisted business data. A custom public form can still have its own `data.website` answer.

Obtain a challenge from `GET /api/v1/bot-protection/challenge?method=POST&path=%2Fauth%2Flogin`. Sensitive dashboard actions use `/bot-protection/authenticated-challenge` with the existing authenticated session. Both endpoints return the **raw ALTCHA protocol**, without the normal success/data envelope, and send `Cache-Control: no-store`. Challenge issuance is limited to 30 requests per minute through the existing rate limiter, independently of submission limits. Issuance rejects actions outside the protected allowlist and rejects private actions on the public issuer.

Challenges use SHA-256, a random counter between 1 and 100,000, a 20-minute expiration and a signed scope hash binding the HTTP method, concrete path (including public token or target profile), and user ID for authenticated actions. After checking the signature and solution, Redis `GETDEL` consumes the issued challenge atomically. Concurrent or subsequent reuse fails across API instances. Verification errors return HTTP 400 with `BOT_VERIFICATION_FAILED`; missing configuration or Redis failure returns HTTP 503 with `BOT_PROTECTION_UNAVAILABLE`. Existing guards execute before verification; business validation and side effects execute afterward. There is no production/development bypass or in-memory replay fallback.

A proof is consumed before business DTO validation. After a rejected or failed business request, acquire a fresh proof. A lost HTTP response does not prove whether the business operation completed: check its existing result before manually repeating a consequential action. CAPTCHA does not add business-operation idempotency.

## Web integration

Render `BotProtection` inside the relevant form (or its action card), with its exact API path, method and `authenticated` flag. Use `useBotProtectionReady(path, method)` to disable the submit button until verification succeeds, in addition to existing pending/validation checks. Registration also registers `/auth/login` as its `followUpPath`, acquiring a new action-bound proof for the existing automatic sign-in step without rendering a second widget. The existing API client obtains fields from the registered component, rejects duplicate in-flight submissions, and retains the same proof during a silent 401/session refresh retry. The server checks authentication before consuming that proof.

Verification begins only when the user clicks the visible checkbox. Every protected form disables its submit action until the checkbox has completed verification. The API client also rejects attempts to submit programmatically without the verified proof. Unchecking the box, expiration, a consumed proof or a failed submission disables the action again. A compact live status and retry button report load, timeout and expiration failures; entered form values remain intact. Retrying resets the checkbox and requires a fresh explicit check. Browser work has a 30-second deadline and stops on unmount. The widget's internal checkbox is detached from native form validation because the API submission controller manages proof acquisition; this prevents a pending solve from swallowing Submit. The separate honeypot has no keyboard or accessibility-tree presence and disables autofill.

To add another protected action, update both explicit route policies, add the shared component to every UI caller, and use `ApiBotProtection(BusinessDto)` for Swagger. The global interceptor enforces the backend policy even for direct API requests. Do not put CAPTCHA fields into business schemas or arbitrary form answers. Regression-test alternate endpoints, strict DTO handling and rejected requests producing no business side effects.

## Configuration and deployment

1. Generate a random server-only secret with `openssl rand -hex 32` and configure `ALTCHA_HMAC_KEY` in every API environment/instance. Startup validation requires at least 32 characters. Never use a `NEXT_PUBLIC_` variable or commit a real key.
2. Keep existing Redis configuration available. Both ioredis and Upstash use the existing atomic consume operation. Rotate the HMAC key across API instances together; rotation invalidates outstanding proofs and users must retry verification.
3. Deploy API and web together: protected request bodies are a required API-contract change. Independent clients must supply solved proofs too. No database migration or permission changes are required.
4. Use HTTPS in deployment; browsers permit local development on localhost. The bundled widget uses workers; if a strict CSP is introduced, follow ALTCHA's worker/script requirements without weakening unrelated CSP directives.
5. Observe existing request logs and error codes for verification failures, infrastructure outages and 429s. Logs/telemetry must exclude raw proof payloads, honeypot values, passwords and form answers. Existing request-data redaction remains enabled.

## Validation

Tests use real library-signed challenges and real browser-worker solutions; no production bypass is added. Coverage includes simultaneous replay, altered signatures/solutions, expiration, action/form/user binding, Redis failure, strict DTO preservation, HTTP guard ordering, raw challenge/proxy responses, and public requests with stale account cookies. Browser scenarios cover fresh retry proofs, challenge outages, honeypots, keyboard access, a 320px viewport with simulated CPU slowdown at the maximum counter, password-change session refresh, staff invitations, broadcasts, and existing authentication/public-form flows. Browser APIs and business services are fixtures; these tests do not create live accounts, send emails or queue real broadcasts. Viewport/CPU simulation is not a physical-device benchmark.

Completed checks for the checkbox/runtime repair: 38 real-proof API security checks, all 559 web unit checks, 50 focused browser checks, scoped ESLint, TypeScript, both production builds and the isolated runtime-package proof check passed. The focused browser run excludes seven unrelated billing-only scenarios found in the broader run: five still expect `/dashboard` instead of the existing `/home` destination; the other two expect older non-billing access and cancelled-payment notice behavior. Those expectations/product behaviors were not changed by this work. No production migration, deployment, account creation, email delivery or real broadcast was performed.

The dependencies are pinned to ALTCHA widget 3.5.0 and library 2.8.0. The backend's small declaration bridge accommodates the library's legacy `types` entry with this repository's CommonJS TypeScript resolution; runtime loading uses literal `require()` calls to supported public exports. Do not replace these calls with an aliased/dynamic loader: Vercel’s dependency tracer must discover the package and its SHA algorithm implementation. Review the bridge and rerun real-proof tests when upgrading either package. The web uses the server library only as a development dependency for independent browser fixtures.

References: [server integration](https://altcha.org/docs/integration/server/), [security recommendations](https://altcha.org/docs/integration/security-recommendations/), [widget integration](https://altcha.org/docs/integration/widget/).

## Vercel runtime packaging repair (2026-11-05)

The production runtime log for request `c5xxf-1793895813580-7f6fe81f06d6` reported `Cannot find module 'altcha-lib'` from `/var/task/src/bot-protection/altcha.js`. The production HMAC key was present. Although installation succeeded, the aliased `createRequire` loader prevented Vercel’s file tracer from including ALTCHA in the function.

The compatibility bridge now uses statically traceable literal imports. Before the repair, Vercel Node File Trace found zero ALTCHA package files from the compiled bridge. Afterward, it found ten ALTCHA files (twelve total files, zero tracer warnings). An isolated function directory containing only that traced output successfully generated, solved and verified a signed challenge in a fresh Node process. This check used local fixtures and made no external calls. Push and redeploy the backend to replace the currently deployed function; redeploy the web to display the required checkbox. No environment-variable or database changes are required for this repair.
