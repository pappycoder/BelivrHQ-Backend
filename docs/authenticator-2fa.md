# Backend-managed authenticator two-factor authentication

## Ownership and scope

Supabase handles email/password authentication and signs access tokens. BelivrHQ owns TOTP enrollment, verification, recovery, replay prevention, and second-factor session approvals. New authenticator accounts do not use Supabase MFA APIs or require Supabase TOTP settings.

All users manage their own authenticator under Profile → Security. Role and branch permissions remain independent. TOTP uses OTPAuth with SHA-1, six digits, a 30-second interval, and a one-step clock tolerance. QR codes are generated locally; no secret is sent to a QR service.

## Storage and session enforcement

`profile_authenticators` stores an AES-256-GCM ciphertext with a random IV and authenticated user binding, the enrollment revision, last accepted time step, and recovery-code hashes. The dedicated 32-byte `TWO_FACTOR_ENCRYPTION_KEY` has no default. Never commit it or replace it without re-encrypting existing secrets.

`verified_mfa_sessions` binds an MFA approval to both the verified Supabase user ID and JWT `session_id`, and the current authenticator revision. Approval expires after 12 hours, even if tokens refresh. Password-only tokens and Supabase AAL2 tokens without backend approval are rejected for enabled accounts. JWT signatures and revocation checks still run. The session ID survives ordinary token refresh; a different session requires its own verification.

Successful TOTP verification updates the accepted time step conditionally, preventing concurrent reuse. Recovery codes contain 128 random bits; only SHA-256 hashes bound to user/enrollment are stored. Conditional array updates ensure a code cannot be consumed twice. The secret and recovery hashes are excluded from profile responses.

Redis holds five-minute withheld login sessions and ten-minute encrypted enrollment state. A pending login allows at most five submissions; a shared per-account budget limits all verification attempts to ten per five-minute bucket. Redis failures never release a password-only session. Login challenges are consumed atomically.

Setup confirms a current code before enabling MFA. It approves only the session used for confirmation and clears all prior approvals. Disable requires a current authenticator or unused recovery code and removes the secret, recovery hashes, and approvals transactionally. Logout, forced sign-out, deactivation, and password changes revoke backend approvals.

## Recovery

Enrollment generates ten recovery codes, displayed once. Save them in a password manager or another secure location. The UI asks users to confirm they saved them before continuing. Login offers “Use a recovery code”; every code works once. Profile shows the remaining count and can replace all codes after verifying a current authenticator or recovery code. Replacement invalidates every previous code.

If both authenticator and recovery codes are lost, recovery requires an operator to verify identity. There is no email bypass. A verified operator reset must delete the user's authenticator and approved-session rows and clear both profile flags in one transaction; do not expose this as an unauthenticated recovery endpoint.

## Existing accounts

Old email-2FA users verify their old email code once, then enroll and confirm a backend authenticator before receiving tokens. Existing Supabase-TOTP users similarly verify their old authenticator once and enroll a new backend secret. The latter bridge is the only MFA verification that calls Supabase. Neither bridge releases an application session before backend confirmation. Old Supabase factors can be removed administratively after migration; backend logins no longer depend on them. Users without 2FA retain normal password login.

## API

- `GET /profiles/me/2fa/factors`: own metadata and remaining recovery-code count.
- `POST /profiles/me/2fa/setup`: QR/manual-key enrollment.
- `POST /profiles/me/2fa/enable`: `{ factorId, code }`; returns one-time `recoveryCodes`.
- `POST /profiles/me/2fa/disable`: `{ factorId, code }`; removes own authenticator.
- `POST /profiles/me/2fa/recovery-codes`: `{ factorId, code }`; replaces recovery codes.
- `POST /auth/login/2fa`: `{ challengeToken, code }`; legacy email migration initially accepts `{ email, code }`.

## Rollout

1. Generate a key with `openssl rand -hex 32`; store it as `TWO_FACTOR_ENCRYPTION_KEY` in the backend secret manager on every instance. Keep a secure backup.
2. Apply the additive migration with `npx prisma migrate deploy` before deploying the new backend. This creates two tables and preserves existing account flags/data. No permission seed is needed.
3. Deploy backend and web together because the profile API contract changed.
4. Keep server clocks synchronized. Keep the same encryption key across instances/restarts.
5. Before rollout, exercise enrollment, incorrect/reused codes, recovery-code login/regeneration, ordinary token refresh, separate password-only tokens, disabling, and both applicable migration paths against the configured environment. Builds/typechecks do not exercise live login or prove deployment configuration.

No database migration or live account changes are performed by compilation. Mobile currently has no implementation in this repository; future clients must handle the challenge and recovery responses.

References: https://datatracker.ietf.org/doc/html/rfc6238, https://github.com/hectorm/otpauth, and https://supabase.com/docs/guides/auth/sessions
