import { applyAdjustment, parsePaymentEvent } from '../../../src/giving/services/payment-lifecycle';
import {
  appendAccessGrant,
  resolvePaymentAccess,
  projectSubscription,
} from '../../../src/billing/payment-access';

describe('payment lifecycle ordering and accounting', () => {
  const refund = {
    id: 'r1',
    kind: 'refund' as const,
    state: 'completed' as const,
    amount: 40,
    currency: 'NGN',
  };
  it('deduplicates partial refunds and holds affected access for review', () => {
    const first = applyAdjustment(null, refund, 100, 'NGN');
    expect(first).toMatchObject({ refundedAmount: 40, access: 'review' });
    expect(applyAdjustment(first, refund, 100, 'NGN')).toEqual(first);
    const full = applyAdjustment(first, { ...refund, id: 'r2', amount: 60 }, 100, 'NGN');
    expect(full).toMatchObject({ refundedAmount: 100, access: 'revoked' });
    expect(applyAdjustment(full, { ...refund, state: 'failed' }, 100, 'NGN')).toEqual(full);
  });
  it.each(['pending', 'failed'] as const)('never reverses a %s refund', (state) => {
    expect(applyAdjustment(null, { ...refund, state }, 100, 'NGN')).toMatchObject({
      access: 'clear',
      refundedAmount: 0,
    });
  });
  it.each([{ amount: -1 }, { amount: Infinity }, { amount: 101 }, { currency: 'USD' }])(
    'rejects invalid adjustment %j',
    (invalid) => {
      expect(() => applyAdjustment(null, { ...refund, ...invalid }, 100, 'NGN')).toThrow();
    },
  );
  it('does not double count a verified full reversal on top of an earlier partial refund', () => {
    const partial = applyAdjustment(null, refund, 100, 'NGN');
    expect(
      applyAdjustment(
        partial,
        { id: 'original-charge', kind: 'reversal', state: 'completed', amount: 100 },
        100,
        'NGN',
      ),
    ).toMatchObject({ refundedAmount: 100, access: 'revoked', financialReversal: true });
  });
  it('rejects cumulative refunds exceeding the charge', () => {
    const first = applyAdjustment(null, refund, 100, 'NGN');
    expect(() => applyAdjustment(first, { ...refund, id: 'r2', amount: 70 }, 100, 'NGN')).toThrow();
  });
  it('holds open disputes and restores a won dispute without undoing a refund', () => {
    const open = { id: 'd1', kind: 'dispute' as const, state: 'open' as const };
    const held = applyAdjustment(null, open, 100, 'NGN');
    expect(held.access).toBe('review');
    const won = applyAdjustment(held, { ...open, state: 'won' }, 100, 'NGN');
    expect(won.access).toBe('clear');
    expect(applyAdjustment(won, open, 100, 'NGN').access).toBe('clear');
    expect(applyAdjustment(won, refund, 100, 'NGN').access).toBe('review');
  });
  it('holds reopened disputes while rejecting an older open callback', () => {
    const won = applyAdjustment(
      null,
      { id: 'd', kind: 'dispute', state: 'won', stage: 'new', updatedAt: '2026-11-01T10:00:00Z' },
      100,
      'NGN',
    );
    expect(
      applyAdjustment(
        won,
        {
          id: 'd',
          kind: 'dispute',
          state: 'open',
          stage: 'new',
          updatedAt: '2026-10-01T10:00:00Z',
        },
        100,
        'NGN',
      ).access,
    ).toBe('clear');
    expect(
      applyAdjustment(
        won,
        {
          id: 'd',
          kind: 'dispute',
          state: 'open',
          stage: 'second',
          updatedAt: '2026-11-02T10:00:00Z',
        },
        100,
        'NGN',
      ).access,
    ).toBe('review');
  });
  it('does not accept conflicting final outcomes without a later provider timestamp', () => {
    const lost = {
      id: 'd',
      kind: 'dispute' as const,
      state: 'lost' as const,
      updatedAt: '2026-11-01T10:00:00Z',
    };
    const state = applyAdjustment(null, lost, 100, 'NGN');
    expect(
      applyAdjustment(state, { ...lost, state: 'won', updatedAt: undefined }, 100, 'NGN').access,
    ).toBe('revoked');
    expect(
      applyAdjustment(
        state,
        { ...lost, state: 'won', updatedAt: '2026-11-02T10:00:00Z' },
        100,
        'NGN',
      ).access,
    ).toBe('clear');
  });
});

describe('provider lifecycle payloads', () => {
  it('resolves Paystack refund references through the original nested transaction', () => {
    const event = parsePaymentEvent('paystack', {
      event: 'refund.processed',
      data: {
        id: 9,
        amount: 5000,
        currency: 'NGN',
        transaction: { id: 1, reference: 'church-payment' },
      },
    });
    expect(event).toMatchObject({
      reference: 'church-payment',
      providerTransactionId: '1',
      adjustment: { id: '9', amount: 50, state: 'completed' },
    });
  });
  it.each(['completed', 'processing', 'pending-momo', 'pending-mpgs', 'pending-bank-transfer'])(
    'keeps Flutterwave %s refunds pending',
    (status) => {
      expect(
        parsePaymentEvent('flutterwave', {
          event: 'refund.completed',
          data: { id: 1, tx_id: 99, status, amount_refunded: 50 },
        }).adjustment?.state,
      ).toBe('pending');
    },
  );
  it.each([
    'completed-bank-transfer',
    'completed-momo',
    'completed-mpgs',
    'completed-offline',
    'completed-preauth',
  ])('settles Flutterwave %s refunds', (status) => {
    expect(
      parsePaymentEvent('flutterwave', {
        event: 'refund.completed',
        data: { id: 1, tx_id: 99, status, amount_refunded: 50 },
      }).adjustment,
    ).toMatchObject({ state: 'completed', amount: 50 });
  });
  it('accepts the separate unwrapped Flutterwave refund callback without treating initiation as disbursement', () => {
    expect(
      parsePaymentEvent('flutterwave', {
        id: 123,
        AmountRefunded: 50,
        status: 'completed',
        TransactionId: 99,
      }).providerTransactionId,
    ).toBe('99');
  });
  it.each([
    ['initiated', 'open'],
    ['declined', 'open'],
    ['accepted', 'lost'],
    ['lost', 'lost'],
    ['won', 'won'],
    ['reversed', 'won'],
  ])('normalizes Flutterwave chargeback %s', (status, state) => {
    expect(
      parsePaymentEvent('flutterwave', {
        event: `chargeback.${status}`,
        data: { id: 9, flw_ref: 'provider-ref', status },
      }).adjustment?.state,
    ).toBe(state);
  });
  it('keeps unfamiliar dispute resolutions under review', () => {
    expect(
      parsePaymentEvent('paystack', {
        event: 'charge.dispute.resolve',
        data: { id: 9, resolution: 'unknown' },
      }).adjustment?.state,
    ).toBe('open');
  });
});

describe('payment-funded access periods', () => {
  const baseline = {
    plan: 'essentials' as const,
    cycle: 'monthly' as const,
    paid_until: new Date('2026-11-01'),
  };
  const first = {
    reference: 'one',
    plan: 'community' as const,
    cycle: 'monthly' as const,
    start: '2026-11-01',
    end: '2026-12-01',
    state: 'clear' as const,
  };
  it('holds only the affected period and preserves later paid access without extending its dates', () => {
    let access = appendAccessGrant(null, baseline, first);
    access = appendAccessGrant(access, baseline, {
      ...first,
      reference: 'two',
      start: '2026-12-01',
      end: '2027-01-01',
    });
    access.grants.find((grant) => grant.reference === 'one')!.state = 'review';
    expect(resolvePaymentAccess(access, new Date('2026-11-15'))).toMatchObject({
      active: false,
      held: true,
    });
    expect(resolvePaymentAccess(access, new Date('2026-12-15'))).toMatchObject({
      active: true,
      selected: { reference: 'two', end: '2027-01-01' },
    });
  });
  it('revokes an upgrade while preserving the original paid base plan', () => {
    const access = appendAccessGrant(
      null,
      { ...baseline, paid_until: new Date('2026-12-01') },
      { ...first, plan: 'network', upgrade: true, state: 'revoked' },
    );
    expect(resolvePaymentAccess(access, new Date('2026-11-15')).selected?.plan).toBe('essentials');
  });
  it('cannot retain upgraded access after its underlying base period is revoked', () => {
    const access = appendAccessGrant({ grants: [{ ...first, state: 'revoked' }] }, baseline, {
      ...first,
      reference: 'upgrade',
      plan: 'network',
      upgrade: true,
    });
    expect(resolvePaymentAccess(access, new Date('2026-11-15')).active).toBe(false);
  });
  it('retains pre-ledger subscriptions and does not invent access', () => {
    const subscription = { ...baseline, church_id: 'church' };
    expect(projectSubscription(subscription as never)).toBe(subscription);
    expect(resolvePaymentAccess(null).tracked).toBe(false);
  });
});
