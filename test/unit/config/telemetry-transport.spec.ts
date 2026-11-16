import * as Sentry from '@sentry/nestjs';
import { redactTelemetry } from '../../../src/config/telemetry-privacy';

// Exercise the installed SDK's actual transaction serialization, without network access.
it('scrubs completed traces before the SDK sends its envelope', async () => {
  const envelopes: unknown[] = [];
  const secret = 'synthetic-transport-secret';
  Sentry.init({
    dsn: 'https://public@ingest.example/1',
    defaultIntegrations: false,
    tracesSampleRate: 1,
    traceLifecycle: 'static',
    beforeSendTransaction: redactTelemetry,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  try {
    Sentry.startSpan(
      {
        name: `https://example.org/forms/public/${secret}?token=${secret}`,
        op: 'http.server',
        forceTransaction: true,
      },
      () => {
        Sentry.startSpan({ name: `SELECT '${secret}'`, op: 'db.query' }, (span) => {
          span.setAttribute('password', secret);
        });
      },
    );
    await Sentry.flush(3000);
    const output = JSON.stringify(envelopes);
    expect(output).toContain('"transaction"');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain(secret);
  } finally {
    await Sentry.close(1000);
  }
});
