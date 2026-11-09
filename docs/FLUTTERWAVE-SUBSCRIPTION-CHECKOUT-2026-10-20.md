# Flutterwave subscription checkout and registration sessions

New BelivrHQ subscription quotes and checkouts accept only `flutterwave`.
The status response advertises only that gateway and its approved currencies;
the browser shows one fixed Flutterwave provider. Church-owned giving integrations
are unchanged. Historical Paystack ledger records, verification and signed callbacks
remain readable/reconcilable; they cannot create new Paystack subscription payments.

## Reproduced checkout failure

The configured Flutterwave test key returned HTTP 200 with a hosted URL on
`checkout-v2.dev-flutterwave.com`. Our exact-host allowlist rejected this, causing
the reported “The payment provider returned an invalid checkout” 503. The diagnostic
link was immediately disabled through Flutterwave's API; no charge was made and no
BelivrHQ database record was created.

Both API and browser now recognize that exact development checkout host alongside
`checkout.flutterwave.com` and `ravemodal.flutterwave.com`. The API permits the
development host only when `FLUTTERWAVE_SECRET_KEY` starts with `FLWSECK_TEST-`.
HTTPS, exact hostnames, no credentials/custom ports and matching payment references
remain required. Stored checkout URLs are validated again when resuming. Unrelated
domains and lookalike subdomains remain rejected.

## Registration session

The connected Supabase public settings confirmed automatic email confirmation.
Registration previously discarded its signup session and relied on a second login
request. Registration now uses an isolated auth client and releases the signup
session only after church/profile creation and the existing authenticated-session
approval. Approval failure leaves registration successful and withholds tokens.

The web proxy handles `auth/register` as a session endpoint, excludes any previous
account's authorization, strips access/refresh tokens from browser JSON and saves
them as HttpOnly cookies. The browser opens `/subscription` using that session,
without a second login request. Email confirmation remains required when enabled;
older backend responses and transient approval failures retain the sign-in fallback.

## Validation and deployment

- Backend: 96 focused auth/billing tests and 9 disposable PostgreSQL/HTTP tests passed.
- Web: 9 cookie-session/redirect unit checks and 29 onboarding/currency/billing browser checks passed.
- Backend/web production builds, TypeScript and targeted lint passed (four existing test `any` warnings).
- One real uncharged Flutterwave test link was created and disabled to verify the provider host.

Deploy API and web together, using the existing platform Flutterwave secret and
webhook hash. No database migration is required. Redis remains required for locked
payment quotes. No application database changes, real registrations, charges or
deployments were performed by this fix.

Flutterwave's hosted-link workflow: [Flutterwave Standard](https://developer.flutterwave.com/docs/flutterwave-standard-1).
