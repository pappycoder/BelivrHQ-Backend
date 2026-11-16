# Backend console

Run `npm run console` or `bash scripts/console.sh`. The script also works by absolute path from another directory.

| Option | Action |
|---|---|
| 1 | Dev build: run the development server in watch mode |
| 2 | Production build: compile the application |
| 3 | Run unit tests |
| 4 | Deploy database migrations, after a verified backup |
| 5 | Create a super user (`super_admin`) |
| 6 | Create a church admin (`church_admin`) |

Press Enter after a command to return to the menu; `q` quits. Failures return to the menu. There are no Tools submenus or extra action shortcuts. Production build only compiles; it does not start a production server or deploy the app. Vercel handles application deployment.

Use Node.js 20.19+ or 22.12+, Bash 3.2+ and installed project dependencies. npm is the default; `--manager pnpm` is supported.

```sh
bash scripts/console.sh --help
bash scripts/console.sh --list
bash scripts/console.sh --dry-run --action build
```

The default environment is `.env`. Select another with `--env FILE`, relative to your invocation directory. Selected dotenv values override inherited values; files are parsed as data, never sourced or evaluated. Dry runs do not execute commands, contact services or write data. Passwords and credentials are not included in printed commands.

## Migrations and administrators

```sh
bash scripts/console.sh --env .env.production --action migration-deploy
npm run create:super-admin
npm run create:church-admin
```

Migrations show the database target and require the displayed confirmation. A verified public-schema backup is mandatory before `prisma migrate deploy`; backup failure stops the migration. Configure matching PostgreSQL tools (`pg_dump`/`pg_restore`) and stop application writers as appropriate. The backup contains application records and needs private storage.

New backups preserve database grants/revocations and use manifest version 2. Automatic restore refuses legacy ACL-less archives; retain them for isolated recovery with reviewed security policies. These public-schema archives exclude Supabase Auth and stored object bytes. See `RECOVERY-AND-CAPACITY.md` for the complete recovery inventory and drill.

Admin creation needs `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, installed dependencies, generated Prisma client and existing reference roles/permissions. Choose a new login or explicitly link an orphan auth UUID with no application profile. Enter the password twice (hidden), names, optional phone, and an existing church UUID or new church name. Passwords require 12+ characters including upper/lowercase, number and symbol. Review the church/database/auth target and confirm.

The account receives exactly the selected role with a branch-linked HQ profile. Existing profiled users are never silently promoted or reassigned. A failed profile transaction compensates only newly created auth identities. Provider/network failures can require manual reconciliation. Configure authenticator security in the application after provisioning.

A new church receives an unpaid Essentials/monthly subscription record before branch/staff creation, matching signup onboarding and database capacity constraints. This does not grant a paid interval or alter an existing church's subscription.

`--action` accepts only `dev`, `build`, `test`, `migration-deploy`, `admin-super` and `admin-church`. The old `seed-super-admin` command delegates to this flow.

## Verification

Run `npm run ops:test` for command routing, menu/CLI allowlists, dry runs, failure handling, safe environment parsing and Ctrl-C regressions. Commands are stubbed and no live accounts or databases are changed. Backend tests also cover admin provisioning safeguards and backup-before-migration ordering. `python3 test/ops/terminal.test.py` checks terminal input handling.
