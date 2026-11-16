import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Prisma } from '@prisma/client';

const sql = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20261116160000_backend_only_database_access/migration.sql',
  ),
  'utf8',
);
const tables = [
  ...Prisma.dmmf.datamodel.models.map((model) => model.dbName || model.name),
  '_prisma_migrations',
];
const maintenanceSql = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20261116170000_private_maintenance_functions/migration.sql',
  ),
  'utf8',
);

describe('Backend-only PostgreSQL access boundary', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  afterAll(async () => {
    await pool.end();
  });

  async function denied(client: PoolClient, role: string, statement: string) {
    await client.query('SAVEPOINT denied_operation');
    await client.query(`SET LOCAL ROLE ${role}`); // Static fixture roles only.
    try {
      await expect(client.query(statement)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT denied_operation');
      await client.query('RELEASE SAVEPOINT denied_operation');
    }
  }

  it('protects every modeled table with RLS and denies browser table privileges', async () => {
    const result = await pool.query<{
      table_name: string;
      rls: boolean;
      anon: boolean;
      authenticated: boolean;
    }>(
      `SELECT c.relname AS table_name,c.relrowsecurity AS rls,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anon,
        has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS authenticated
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,
      [tables],
    );
    expect(result.rows).toHaveLength(tables.length);
    expect(result.rows.filter((row) => !row.rls || row.anon || row.authenticated)).toEqual([]);
  });

  it('reapplies hardening while an already-protected table is being written', async () => {
    const writer = await pool.connect();
    const migration = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE public.members IN ROW EXCLUSIVE MODE');
      await migration.query('BEGIN');
      await migration.query("SET LOCAL lock_timeout = '1s'");
      // A normal writer must not block a redundant ENABLE RLS on hardened tables.
      await migration.query(sql);
    } finally {
      await migration.query('ROLLBACK');
      await writer.query('ROLLBACK');
      migration.release();
      writer.release();
    }
  });

  it('closes a Supabase-style grant bypass without rewriting rows or touching unrelated objects', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    const church = randomUUID(),
      member = randomUUID();
    try {
      await client.query('INSERT INTO churches(id,name,updated_at) VALUES ($1,$2,now())', [
        church,
        'Database access fixture',
      ]);
      await client.query(
        "INSERT INTO platform_subscriptions(church_id,plan,cycle,paid_until) VALUES ($1,'network','monthly',now()+interval '7 days')",
        [church],
      );
      await client.query(
        "INSERT INTO members(id,church_id,first_name,last_name,member_since,updated_at) VALUES ($1,$2,'Synthetic','Canary',now(),now())",
        [member, church],
      );
      await client.query('ALTER TABLE public.members DISABLE ROW LEVEL SECURITY');
      await client.query('GRANT SELECT ON public.members TO anon,authenticated');
      await client.query('SET LOCAL ROLE anon');
      expect(
        (await client.query('SELECT id FROM public.members WHERE id=$1', [member])).rows,
      ).toHaveLength(1);
      await client.query('RESET ROLE');
      // An extension/unmanaged relation is deliberately outside the application's table list.
      await client.query('CREATE TABLE public.audit_unmanaged_fixture (id integer)');
      await client.query('GRANT SELECT ON public.audit_unmanaged_fixture TO anon');
      await client.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated',
      );
      await client.query(sql);
      expect(
        (await client.query('SELECT id FROM public.members WHERE id=$1', [member])).rows,
      ).toHaveLength(1);
      for (const role of ['anon', 'authenticated']) {
        await denied(client, role, 'SELECT * FROM public.members LIMIT 0');
        await denied(client, role, 'INSERT INTO public.members DEFAULT VALUES');
        await denied(client, role, 'UPDATE public.members SET first_name=first_name WHERE false');
        await denied(client, role, 'DELETE FROM public.members WHERE false');
        await denied(client, role, "SELECT public.belivrhq_effective_plan('synthetic-church')");
      }
      await client.query('CREATE TABLE public.audit_future_fixture (id integer)');
      const grants = await client.query(
        "SELECT has_table_privilege('anon','public.audit_future_fixture','SELECT') AS anon,has_table_privilege('authenticated','public.audit_future_fixture','SELECT') AS authenticated",
      );
      expect(grants.rows[0]).toEqual({ anon: false, authenticated: false });
      expect(
        (
          await client.query(
            "SELECT has_table_privilege('anon','public.audit_unmanaged_fixture','SELECT') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('removes public execution of privileged maintenance RPCs while preserving their owner', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query(
        'CREATE FUNCTION public.archive_old_messages(p_audit_canary integer) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT p_audit_canary $$',
      );
      await client.query(
        'GRANT EXECUTE ON FUNCTION public.archive_old_messages(integer) TO PUBLIC,anon,authenticated',
      );
      await client.query('SET LOCAL ROLE anon');
      expect(
        (await client.query('SELECT public.archive_old_messages(7) AS result')).rows[0].result,
      ).toBe(7);
      await client.query('RESET ROLE');
      await client.query(maintenanceSql);
      for (const role of ['anon', 'authenticated'])
        await denied(client, role, 'SELECT public.archive_old_messages(7)');
      expect(
        (await client.query('SELECT public.archive_old_messages(7) AS result')).rows[0].result,
      ).toBe(7);
      const path = await client.query(
        "SELECT proconfig FROM pg_proc WHERE oid='public.archive_old_messages(integer)'::regprocedure",
      );
      expect(path.rows[0].proconfig).toContain('search_path=public, pg_temp');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
