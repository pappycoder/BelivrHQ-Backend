import { BadRequestException } from '@nestjs/common';

export interface PaymentAdjustment {
  id: string;
  kind: 'refund' | 'dispute' | 'reversal';
  state: 'pending' | 'failed' | 'completed' | 'open' | 'won' | 'lost';
  amount?: number;
  currency?: string;
  updatedAt?: string;
  stage?: string;
}
export interface PaymentLifecycle {
  review?: {
    fingerprint: string;
    decision: 'release' | 'revoke';
    reason: string;
    reviewedBy: string;
    reviewedAt: string;
  };
  chargeStatus?: string;
  adjustments: PaymentAdjustment[];
  refundedAmount: number;
  financialReversal: boolean;
  access: 'clear' | 'review' | 'revoked';
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function identifier(value: unknown): string | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 200)
    return undefined;
  return String(value) || undefined;
}

/** Keep settled facts monotonic when callbacks are duplicated or delivered late. */
export function applyAdjustment(
  value: unknown,
  incoming: PaymentAdjustment,
  amount: number,
  currency: string,
): PaymentLifecycle {
  if (
    !incoming.id ||
    (incoming.currency && incoming.currency !== currency) ||
    (incoming.amount !== undefined &&
      (!Number.isFinite(incoming.amount) || incoming.amount < 0 || incoming.amount > amount))
  )
    throw new BadRequestException('Invalid payment adjustment details');
  const saved = record(value);
  const adjustments = (
    Array.isArray(saved.adjustments) ? saved.adjustments : []
  ) as PaymentAdjustment[];
  const key = (item: PaymentAdjustment) => `${item.kind}/${item.id}`;
  const previous = adjustments.find((item) => key(item) === key(incoming));
  const final = (item: PaymentAdjustment) => ['completed', 'won', 'lost'].includes(item.state);
  // Final callbacks cannot be downgraded by a delayed pending/failed notification.
  // Conflicting final dispute outcomes require a newer provider timestamp.
  const newer = !!(
    previous?.updatedAt &&
    incoming.updatedAt &&
    Date.parse(incoming.updatedAt) > Date.parse(previous.updatedAt)
  );
  const stageRank = (stage?: string) =>
    ({ new: 0, second: 1, 'pre-arbitration': 2, arbitration: 3 })[stage ?? ''] ?? -1;
  const laterStage = stageRank(incoming.stage) > stageRank(previous?.stage);
  const reopened =
    incoming.kind === 'dispute' &&
    incoming.state === 'open' &&
    (newer || stageRank(incoming.stage) > stageRank(previous?.stage));
  const stale =
    previous &&
    ((['refund', 'reversal'].includes(previous.kind) &&
      previous.state === 'completed' &&
      (previous.amount !== undefined || incoming.state !== 'completed')) ||
      (final(previous) && !final(incoming) && !reopened) ||
      (previous.updatedAt &&
        incoming.updatedAt &&
        Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt)) ||
      (final(previous) &&
        final(incoming) &&
        previous.state !== incoming.state &&
        !newer &&
        !laterStage));
  const next = stale
    ? previous
    : {
        ...incoming,
        amount: incoming.amount ?? previous?.amount,
        currency: incoming.currency ?? previous?.currency,
        updatedAt: incoming.updatedAt ?? previous?.updatedAt,
        stage: incoming.stage ?? previous?.stage,
      };
  const merged = [...adjustments.filter((item) => key(item) !== key(incoming)), next].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
  const refundedSum =
    merged
      .filter((item) => item.kind === 'refund' && item.state === 'completed')
      .reduce((sum, item) => sum + Math.round((item.amount ?? 0) * 100), 0) / 100;
  if (Math.round(refundedSum * 100) > Math.round(amount * 100))
    throw new BadRequestException('Refund total exceeds the original payment');
  const reversed = merged.some((item) => item.kind === 'reversal' && item.state === 'completed');
  const refundedAmount = reversed ? amount : refundedSum;
  const lost = merged.some((item) => item.kind === 'dispute' && item.state === 'lost');
  const unknownRefund = merged.some(
    (item) => item.kind === 'refund' && item.state === 'completed' && item.amount === undefined,
  );
  const open = merged.some((item) => item.kind === 'dispute' && item.state === 'open');
  const review = saved.review as PaymentLifecycle['review'];
  const decision =
    review?.fingerprint === adjustmentFingerprint(merged) ? review.decision : undefined;
  const financialReversal =
    reversed ||
    lost ||
    (amount > 0 && Math.round(refundedAmount * 100) === Math.round(amount * 100));
  return {
    financialReversal,
    ...(review ? { review } : {}),
    ...(typeof saved.chargeStatus === 'string' ? { chargeStatus: saved.chargeStatus } : {}),
    adjustments: merged,
    refundedAmount,
    access:
      reversed ||
      lost ||
      (amount > 0 && Math.round(refundedAmount * 100) === Math.round(amount * 100))
        ? 'revoked'
        : decision === 'release'
          ? 'clear'
          : decision === 'revoke'
            ? 'revoked'
            : open || unknownRefund || refundedAmount > 0
              ? 'review'
              : 'clear',
  };
}

export function adjustmentFingerprint(adjustments: PaymentAdjustment[]): string {
  return JSON.stringify(
    adjustments
      .map((item) => [
        item.kind,
        item.id,
        item.state,
        item.amount ?? null,
        item.currency ?? null,
        item.updatedAt ?? null,
        item.stage ?? null,
      ])
      .sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])),
      ),
  );
}

/** Parse provider-specific adjustment facts without trusting these for charge success. */
export function parsePaymentEvent(provider: string, body: Record<string, unknown>) {
  const data = record(body.data ?? body);
  const event =
    typeof body.event === 'string'
      ? body.event
      : provider === 'flutterwave' && data.AmountRefunded !== undefined
        ? 'refund.update'
        : '';
  const transaction = record(data.transaction);
  const isRefund = event.startsWith('refund.');
  const isDispute = event.startsWith('charge.dispute.') || event.startsWith('chargeback.');
  const status = String(data.status ?? event.split('.').pop() ?? '').toLowerCase();
  const reference =
    identifier(
      transaction.reference ??
        transaction.tx_ref ??
        data.tx_ref ??
        data.transaction_reference ??
        (!isRefund && !isDispute ? data.reference : undefined),
    ) ?? '';
  const providerTransactionId = identifier(
    transaction.id ??
      (typeof data.transaction !== 'object' ? data.transaction : undefined) ??
      data.tx_id ??
      data.TransactionId ??
      data.transaction_id ??
      (!isRefund && !isDispute ? data.id : undefined),
  );
  const providerReference = identifier(data.flw_ref ?? data.FlwRef);
  let adjustment: PaymentAdjustment | undefined;
  if (isRefund || isDispute) {
    const id = identifier(data.id);
    if (!id) throw new BadRequestException('Payment adjustment identifier is required');
    let state: PaymentAdjustment['state'] = isDispute ? 'open' : 'pending';
    if (isRefund) {
      if (provider === 'paystack') {
        if (event === 'refund.processed' || status === 'processed') state = 'completed';
        else if (event === 'refund.failed' || status === 'failed') state = 'failed';
      } else {
        if (/^completed-(bank-transfer|momo|mpgs|offline|preauth)$/.test(status))
          state = 'completed';
        else if (status === 'failed') state = 'failed';
        // Flutterwave `completed` means initiated, not disbursed.
      }
    } else if (provider === 'flutterwave') {
      if (['won', 'reversed'].includes(status)) state = 'won';
      else if (['lost', 'accepted'].includes(status)) state = 'lost';
    } else if (event === 'charge.dispute.resolve') {
      const resolution = String(data.resolution ?? '').toLowerCase();
      if (['merchant-accepted', 'auto-accepted'].includes(resolution)) state = 'lost';
      // Unknown/declined resolutions stay held until the provider confirms funds restored.
    }
    const rawAmount =
      data.amount_refunded ?? data.AmountRefunded ?? data.refund_amount ?? data.amount;
    adjustment = {
      id,
      kind: isRefund ? 'refund' : 'dispute',
      state,
      ...(typeof rawAmount === 'number'
        ? { amount: rawAmount / (provider === 'paystack' ? 100 : 1) }
        : {}),
      ...(typeof data.stage === 'string' ? { stage: data.stage.toLowerCase() } : {}),
      ...(typeof data.currency === 'string' ? { currency: data.currency } : {}),
      ...(typeof (data.updated_at ?? data.updatedAt) === 'string'
        ? { updatedAt: String(data.updated_at ?? data.updatedAt) }
        : {}),
    };
  }
  return { event, reference, providerTransactionId, providerReference, adjustment, data };
}
