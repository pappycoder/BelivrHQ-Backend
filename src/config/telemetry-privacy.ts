import type { Event } from '@sentry/nestjs';
import { observationText } from '../common/privacy';

/** SDK request scrubbing alone does not redact path capabilities or error values. */
export function redactTelemetry<T extends Event>(event: T): T {
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: event.request.url ? observationText(event.request.url) : undefined,
    };
  }
  // The SDK places this separately in the envelope header after event hooks run.
  const sampling = event.sdkProcessingMetadata?.dynamicSamplingContext;
  if (sampling?.transaction) sampling.transaction = observationText(sampling.transaction);
  if (event.user) event.user = { id: event.user.id };
  delete event.extra;
  if (event.contexts) delete event.contexts.request;
  if (event.contexts?.trace) event.contexts.trace.data = {};
  if (event.message) event.message = 'Application event (details omitted)';
  if (event.transaction) event.transaction = observationText(event.transaction);
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (typeof value === 'string' && /url|path|transaction/i.test(key))
      event.tags![key] = observationText(value);
  }
  for (const value of event.exception?.values ?? []) {
    value.value = 'Exception details omitted';
    if (value.mechanism) delete value.mechanism.data;
    for (const frame of value.stacktrace?.frames ?? []) delete frame.vars;
  }
  event.breadcrumbs = event.breadcrumbs
    ?.filter((entry) => !entry.category?.startsWith('ui.'))
    .map((entry) => ({
      timestamp: entry.timestamp,
      type: entry.type,
      category: entry.category,
      level: entry.level,
      data: entry.data?.url ? { url: observationText(String(entry.data.url)) } : undefined,
    }));
  for (const span of event.spans ?? []) {
    span.data = {};
    if (span.description)
      span.description = span.op?.startsWith('db')
        ? 'Database operation'
        : observationText(span.description);
  }
  return event;
}
