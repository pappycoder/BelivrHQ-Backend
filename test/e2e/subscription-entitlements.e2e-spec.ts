import { PrismaService } from '../../src/prisma/prisma.service';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { PLAN_CAPACITIES } from '../../src/billing/plans';

describe('Subscription database enforcement', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const churches: string[] = [];
  async function church(plan = 'essentials') {
    const id = randomUUID();
    churches.push(id);
    await pool.query('INSERT INTO churches(id,name,updated_at) VALUES ($1,$1,now())', [id]);
    await pool.query(
      "INSERT INTO platform_subscriptions(church_id,plan,cycle,paid_until) VALUES ($1,$2,'monthly',now()+interval '30 days')",
      [id, plan],
    );
    return id;
  }
  const member = (id: string) =>
    pool.query(
      "INSERT INTO members(id,church_id,first_name,last_name,updated_at) VALUES ($1,$2,'A','B',now())",
      [randomUUID(), id],
    );
  afterAll(async () => {
    for (const id of churches) {
      await pool.query('DELETE FROM staff_invitation_reservations WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM notifications WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM profiles WHERE church_id=$1', [id]);
      await pool.query(
        'DELETE FROM tickets WHERE event_id IN (SELECT id FROM events WHERE church_id=$1)',
        [id],
      );
      await pool.query('DELETE FROM event_registrations WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM transactions WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM recurring_giving WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM integration_accounts WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM events WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM forms WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM members WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM branches WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM platform_subscriptions WHERE church_id=$1', [id]);
      // Child deletions emit audit rows; remove these scoped fixture records last.
      await pool.query('DELETE FROM audit_logs WHERE church_id=$1', [id]);
      await pool.query('DELETE FROM churches WHERE id=$1', [id]);
    }
    await pool.end();
  });
  it('matches every advertised capacity and fails closed for missing Enterprise agreements', async () => {
    for (const [plan, limits] of Object.entries(PLAN_CAPACITIES)) {
      const id = await church(plan);
      for (const [resource, limit] of Object.entries(limits))
        expect(
          (await pool.query('SELECT belivrhq_plan_limit($1,$2) AS n', [id, resource])).rows[0].n,
        ).toBe(limit);
    }
    const id = await church('enterprise');
    await expect(member(id)).rejects.toThrow('PLAN_LIMIT_REACHED:members');
    await pool.query(
      'UPDATE platform_subscriptions SET enterprise_limits=\'{"members":2000,"staff":20,"locations":5}\' WHERE church_id=$1',
      [id],
    );
    await member(id);
  });
  it('admits exactly one concurrent request for the final member slot, with church-wide counting', async () => {
    const id = await church();
    await pool.query(
      "INSERT INTO members(id,church_id,first_name,last_name,updated_at) SELECT $1||g,$1,'A','B',now() FROM generate_series(1,99) g",
      [id],
    );
    const result = await Promise.allSettled([member(id), member(id)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM members WHERE church_id=$1', [id])).rows[0]
        .n,
    ).toBe(100);
    await pool.query("UPDATE members SET status='inactive' WHERE church_id=$1", [id]);
    await expect(member(id)).rejects.toThrow('PLAN_LIMIT_REACHED:members');
    const record = (await pool.query('SELECT id FROM members WHERE church_id=$1 LIMIT 1', [id]))
      .rows[0].id;
    await pool.query('UPDATE members SET archived_at=now() WHERE id=$1', [record]);
    await member(id);
    await expect(
      pool.query('UPDATE members SET archived_at=NULL WHERE id=$1', [record]),
    ).rejects.toThrow('PLAN_LIMIT_REACHED:members');
  });
  it('reserves seats before invitation, finalizes without double counting and checks reactivation', async () => {
    const id = await church();
    const profile = (email: string) =>
      pool.query(
        "INSERT INTO profiles(id,user_id,church_id,first_name,last_name,role,email,updated_at) VALUES ($1,$1,$2,'A','B',ARRAY[CASE WHEN $3='admin@example.test' THEN 'church_admin' ELSE 'secretary' END],$3,now())",
        [randomUUID(), id, email],
      );
    await profile('admin@example.test');
    await pool.query(
      "INSERT INTO staff_invitation_reservations(id,church_id,email,expires_at) VALUES ($1,$2,'new@example.test',now()+interval '15 minutes')",
      [randomUUID(), id],
    );
    await expect(profile('third@example.test')).rejects.toThrow('PLAN_LIMIT_REACHED:staff');
    await profile('new@example.test');
    await pool.query('DELETE FROM staff_invitation_reservations WHERE church_id=$1', [id]);
    await pool.query(
      "UPDATE profiles SET status='inactive' WHERE church_id=$1 AND email='new@example.test'",
      [id],
    );
    await profile('replacement@example.test');
    await expect(
      pool.query(
        "UPDATE profiles SET status='active' WHERE church_id=$1 AND email='new@example.test'",
        [id],
      ),
    ).rejects.toThrow('PLAN_LIMIT_REACHED:staff');
  });
  it('counts HQ as a location and keeps historic feature data on downgrade', async () => {
    const id = await church('community');
    await pool.query(
      "INSERT INTO branches(id,church_id,name,is_headquarters,updated_at) VALUES ($1,$2,'HQ',true,now())",
      [randomUUID(), id],
    );
    await expect(
      pool.query(
        "INSERT INTO branches(id,church_id,name,updated_at) VALUES ($1,$2,'Other',now())",
        [randomUUID(), id],
      ),
    ).rejects.toThrow('PLAN_LIMIT_REACHED:locations');
    await pool.query(
      "INSERT INTO forms(id,church_id,title,updated_at) VALUES ($1,$2,'History',now())",
      [randomUUID(), id],
    );
    await pool.query("UPDATE platform_subscriptions SET plan='essentials' WHERE church_id=$1", [
      id,
    ]);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM forms WHERE church_id=$1', [id])).rows[0].n,
    ).toBe(1);
    await expect(
      pool.query("INSERT INTO forms(id,church_id,title,updated_at) VALUES ($1,$2,'New',now())", [
        randomUUID(),
        id,
      ]),
    ).rejects.toThrow('PLAN_FEATURE_REQUIRED:forms');
  });
  it('notifies only administrators at thresholds and deduplicates allowance/renewal bell alerts', async () => {
    const id = await church();
    const admin = randomUUID(),
      staff = randomUUID();
    for (const [profile, role] of [
      [admin, 'church_admin'],
      [staff, 'secretary'],
    ])
      await pool.query(
        "INSERT INTO profiles(id,user_id,church_id,first_name,last_name,role,updated_at) VALUES ($1,$1,$2,'A','B',ARRAY[$3],now())",
        [profile, id, role],
      );
    await pool.query(
      "INSERT INTO members(id,church_id,first_name,last_name,updated_at) SELECT $1||g,$1,'A','B',now() FROM generate_series(1,100) g",
      [id],
    );
    const alerts = (
      await pool.query(
        "SELECT profile_id,data->>'threshold' AS band FROM notifications WHERE church_id=$1 AND data->>'resource'='members' ORDER BY created_at,id",
        [id],
      )
    ).rows;
    expect(alerts).toHaveLength(3);
    expect(alerts.every((a) => a.profile_id === admin)).toBe(true);
    expect(alerts.map((a) => Number(a.band)).sort()).toEqual([100, 80, 90].sort());
    await pool.query(
      "UPDATE platform_subscriptions SET paid_until=now()+interval '5 days' WHERE church_id=$1",
      [id],
    );
    await pool.query('SELECT belivrhq_notify_renewal($1)', [id]);
    await pool.query('SELECT belivrhq_notify_renewal($1)', [id]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM notifications WHERE church_id=$1 AND data->>'resource'='renewal'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM notifications WHERE profile_id=$1', [
          staff,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
  it('exposes a safe actionable error through the actual Prisma PostgreSQL adapter', async () => {
    const id = await church();
    await pool.query(
      "INSERT INTO members(id,church_id,first_name,last_name,updated_at) SELECT $1||g,$1,'A','B',now() FROM generate_series(1,100) g",
      [id],
    );
    const prisma = new PrismaService();
    try {
      let failure: unknown;
      try {
        await prisma.member.create({
          data: { church_id: id, first_name: 'Over', last_name: 'Limit' },
        });
      } catch (error) {
        failure = error;
      }
      const filter = new GlobalExceptionFilter() as unknown as {
        handleError(error: unknown): { code: string; message: string };
      };
      expect(filter.handleError(failure)).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
      expect(filter.handleError(failure).message).not.toContain('INSERT');
    } finally {
      await prisma.$disconnect();
    }
  });
  it('preserves accepted payment facts and paid ticket settlement after expiry without allowing new giving', async () => {
    const id = await church('network');
    const person = randomUUID(),
      event = randomUUID(),
      transaction = randomUUID(),
      registration = randomUUID(),
      account = randomUUID(),
      recurring = randomUUID();
    await pool.query(
      "INSERT INTO members(id,church_id,first_name,last_name,updated_at) VALUES ($1,$2,'A','B',now())",
      [person, id],
    );
    await pool.query(
      "INSERT INTO events(id,church_id,title,start_date,is_free,updated_at) VALUES ($1,$2,'Paid',now(),false,now())",
      [event, id],
    );
    await pool.query(
      'INSERT INTO transactions(id,church_id,amount,payment_reference,updated_at) VALUES ($1,$2,100,$1,now())',
      [transaction, id],
    );
    await pool.query(
      'INSERT INTO event_registrations(id,church_id,event_id,member_id,payment_reference,transaction_id) VALUES ($1,$2,$3,$4,$5,$5)',
      [registration, id, event, person, transaction],
    );
    await pool.query(
      "INSERT INTO integration_accounts(id,church_id,provider,label,ciphertext) VALUES ($1,$2,'paystack','Test','encrypted')",
      [account, id],
    );
    await pool.query(
      "INSERT INTO recurring_giving(id,church_id,member_id,category_id,integration_account_id,amount,frequency,authorization_code,updated_at) VALUES ($1,$2,$3,'category',$4,100,'monthly','existing-authorization',now())",
      [recurring, id, person, account],
    );
    await pool.query(
      "UPDATE platform_subscriptions SET paid_until=now()-interval '1 day' WHERE church_id=$1",
      [id],
    );
    await pool.query("UPDATE transactions SET status='success' WHERE id=$1", [transaction]);
    await pool.query("UPDATE event_registrations SET payment_status='paid' WHERE id=$1", [
      registration,
    ]);
    await pool.query(
      "INSERT INTO tickets(id,event_id,code,member_id,registration_id,status,price_paid,transaction_id,payment_reference) VALUES ($1,$2,$1,$3,$4,'paid',100,$5,$5)",
      [randomUUID(), event, person, registration, transaction],
    );
    await pool.query(
      "INSERT INTO transactions(id,church_id,integration_account_id,amount,status,metadata,updated_at) VALUES ($1,$2,$3,100,'success',jsonb_build_object('recurring_giving_id',$4::text),now())",
      [randomUUID(), id, account, recurring],
    );
    await expect(
      pool.query(
        'INSERT INTO transactions(id,church_id,amount,updated_at) VALUES ($1,$2,100,now())',
        [randomUUID(), id],
      ),
    ).rejects.toThrow('PLAN_FEATURE_REQUIRED:giving');
  });
});
