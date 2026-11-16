const queues = new Set([
  'whatsapp-outbound',
  'email-outbound',
  'sms-outbound',
  'recurring-giving',
  'nightly-jobs',
  'broadcast',
  'webhook-delivery',
]);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

/** Never serialize legacy job payloads or provider error text in an operator listing. */
export function failureSummary(job: { id?: unknown; data?: unknown }) {
  const recordId = identifier(job.id) ? job.id : undefined;
  const data =
    job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>) : {};
  if (
    data.version !== 1 ||
    !queues.has(String(data.queue)) ||
    !identifier(data.jobId) ||
    !Number.isInteger(data.attempts) ||
    Number(data.attempts) < 0
  )
    return { recordId, legacy: true };
  return {
    recordId,
    queue: String(data.queue),
    jobId: data.jobId,
    attempts: Number(data.attempts),
    churchId: identifier(data.churchId) ? data.churchId : undefined,
    failedAt:
      typeof data.failedAt === 'number' && Number.isFinite(data.failedAt)
        ? data.failedAt
        : undefined,
    deliveryId: identifier(data.deliveryId) ? data.deliveryId : undefined,
    reason: 'attempts_exhausted',
    reviewOnly: data.queue !== 'webhook-delivery',
  };
}
