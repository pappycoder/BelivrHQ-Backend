# BelivrHQ Backend

NestJS API for BelivrHQ — Church Management & Digital Ministry Platform.

## Overview

This repository contains the backend API for BelivrHQ. It is built with:

- **NestJS** — Modular TypeScript backend framework
- **Prisma** — Type-safe ORM for PostgreSQL
- **Supabase Auth** — Authentication, MFA, session management (ES256 via JWKS)
- **Supabase Storage** — File uploads (photos, receipts, media)
- **Upstash Redis** — Caching and BullMQ job queues
- **Paystack / Flutterwave** — Payment processing
- **Termii** — WhatsApp + SMS (single messaging platform)
- **Resend** — Email delivery

## Repository Structure

```text
BelivrHQ-Backend/
├── .github/
│   └── workflows/
│       └── populate-project-issues.yml  # Auto-create GitHub issues from CSV
├── prisma/
│   ├── schema.prisma                    # Database schema
│   ├── migrations/                      # Migration files
│   └── seed.ts                          # Seed data
├── scripts/
│   └── populate-issues.js               # Issue population script
├── src/
│   ├── app.module.ts
│   ├── main.ts
│   ├── auth/                            # Supabase Auth integration
│   ├── members/                         # Member management
│   ├── attendance/                      # Attendance and services
│   ├── giving/                          # Payments and receipts
│   ├── whatsapp/                        # WhatsApp webhooks and commands
│   ├── events/                          # Events and ticketing
│   ├── media/                           # Sermons and media
│   ├── pastoral/                        # Pastoral care and intelligence
│   ├── admin/                           # RBAC, config, reports
│   ├── prisma/                          # Prisma client module
│   ├── supabase/                        # Supabase client (auth + storage only)
│   ├── common/                          # Guards, interceptors, filters
│   └── config/                          # Environment configuration
├── belivrhq_github_projects_import.csv  # Project tasks
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env.example
```

## Getting Started

### Prerequisites

- Node.js 20+
- npm or pnpm
- PostgreSQL database
- Supabase project (Auth + Storage only)
- Upstash Redis instance

### Installation

```bash
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

The example contains the required connection settings and commented feature-specific
secrets. Leave standard defaults out of `.env`; see [Environment configuration](docs/ENVIRONMENT.md)
for runtime defaults, optional overrides and production requirements. Church-owned
payment and messaging credentials belong in Integrations.

### Running Locally

```bash
# Start PostgreSQL and Redis (if using Docker)
docker-compose up -d

# Run Prisma migrations
npx prisma migrate dev

# Seed the database (asks for mode: Development full demo / Production reference data)
# Use `npm run prisma:seed-development` or `npm run prisma:seed-production` to skip the prompt
npx prisma db seed

# Development
npm run start:dev

# Production build
npm run build
npm run start:prod
```

### Running Tests

```bash
# Unit tests
npm run test

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e
```

## Database

### Prisma Commands

```bash
# Create a new migration after schema changes
npx prisma migrate dev --name add_members_table

# Apply pending migrations in production
npx prisma migrate deploy

# Reset local database (drops all data)
npx prisma migrate reset

# Generate Prisma Client after schema changes
npx prisma generate

# Open Prisma Studio (visual database browser)
npx prisma studio

# Seed the database (interactive: Development full demo / Production reference data)
npx prisma db seed
```

### Schema Overview

The database schema is defined in `prisma/schema.prisma`. Key models include:

- **Churches & Branches** — Multi-tenant structure
- **Profiles** — Links Supabase Auth users to BelivrHQ roles
- **Members** — Church member records with full contact info
- **Families** — Family groupings and relationships
- **Services & Attendance** — Service scheduling and check-in tracking
- **Giving Categories & Transactions** — Digital and cash giving records
- **Events & Registrations** — Event management and sign-ups
- **Messages & Templates** — WhatsApp communication logs
- **Pastoral Notes** — Encrypted counseling records
- **Audit Logs** — Full activity trail

### Data Isolation

All queries are scoped by `church_id` to ensure multi-tenant data isolation. This is enforced via Prisma middleware and NestJS guards.

### Archive Lifecycle (soft-delete)

Archivable entities carry `archived_at` and move through **Archive → Restore → Purge**:

- **Archive** sets `archived_at`; the row exits active lists (list endpoints filter `archived_at: null` by default) but its data is kept. Each module exposes `POST /<entity>/:id/archive`.
- **Restore** clears `archived_at` via `POST /<entity>/:id/restore`. Members and profiles use `POST /members/:memberId/restore-archive` / `POST /profiles/:profileId/restore-archive` because their plain `restore` routes are the legacy soft-delete undelete.
- **Purge** is the existing hard `DELETE /<entity>/:id` — it still works on archived rows (this is intentional; it is how archived rows are permanently removed). Deletes are deliberately un-guarded against the archived state in every module.
- `GET /<entity>/:id` (detail) stays unfiltered so archived rows remain reachable by ID; update-style mutations 404 an archived row.
- List endpoints accept `?archived=true` to show archived-only rows.
- Every archive/restore is audit-logged with `AuditAction` `ARCHIVE`/`RESTORE` and a snake_case `entity`.
- `churches` is archivable; the request-context middleware rejects requests from a profile whose church is archived, except `POST /church/restore` so an admin can always restore their own church.
- Offline sync (`SyncService`): bootstrap pulls filter `archived_at: null`, and `hydrateChange` returns a tombstone (`data: null`) for rows whose `archived_at` is set — archived rows reach mobile clients as deletions.

The 21 archivable models are members, profiles, visitors, families, events, event ticket tiers, services, sermons, giving categories, departments, cell groups, branches, assets, asset categories, pastoral notes, life events, templates, custom field definitions, forms, webhook subscriptions, and churches. Transactional/join rows (transactions, recurring giving, asset loans/maintenance/depreciation/scans, media, sync queue, form submissions, attendance) are not archived.

## GitHub Project Automation

This repo includes a GitHub Actions workflow that automatically creates issues from `belivrhq_github_projects_import.csv` and adds them to the central BelivrHQ GitHub Project.

### Setup

1. Go to **Settings → Secrets and variables → Actions**
2. Add these repository secrets:

   | Secret | Value |
   |---|---|
   | `GH_PAT` | Personal Access Token with `repo`, `project`, `read:org` scopes |
   | `ORG_NAME` | `pappycoder` |
   | `PROJECT_NUMBER` | `2` |

3. The workflow runs automatically when `belivrhq_github_projects_import.csv` is pushed to `main`
4. You can also trigger it manually from the **Actions** tab

### Creating the PAT

1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Select:
   - ✅ `repo`
   - ✅ `read:org`
   - ✅ `project`
4. Generate and copy the token
5. Paste it as `GH_PAT` secret in this repo

### Updating Tasks

To update or add new tasks:

1. Edit `belivrhq_github_projects_import.csv`
2. Commit and push to `main`
3. The workflow will:
   - Create new issues
   - Update existing issues (matched by title)
   - Add/update them in project #2 with custom fields (Target Repo, Phase, Module, Priority)
   - Reuse existing project fields when names are already taken

## API Documentation

Once running, API documentation is available at:

```text
http://localhost:3001/api/v1/docs
```

## Deployment

The project is configured for deployment on Railway / Render / Fly.io via the included Dockerfile and GitHub Actions workflow.

## Related Repositories

- [BelivrHQ-Web](https://github.com/pappycoder/BelivrHQ-Web) — Next.js PWA
- [BelivrHQ-Mobile](https://github.com/pappycoder/BelivrHQ-Mobile) — Flutter mobile app
- [BelivrHQ Project Board](https://github.com/orgs/pappycoder/projects/2)

---

*BelivrHQ Backend — Built for Nigerian churches.*

## Interactive operations console

Run `npm run console` for dev build/watch, production build and tests, migration deployment, super-user creation and church-admin creation. Use `bash scripts/console.sh --help` for environment selection and dry runs. See [the operations guide](docs/OPERATIONS-CONSOLE.md) for supported actions, safety controls and tests.

Provider accounts, separate email/WhatsApp/SMS/live-call/payment configuration, deployment and test evidence: [Provider integrations](docs/PROVIDER-INTEGRATIONS.md).
