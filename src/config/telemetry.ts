import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import type { Env } from './env.validation';

export function initializeTelemetry(env: Pick<Env, 'SENTRY_DSN' | 'NODE_ENV'>) {
  // Use identical telemetry privacy rules for HTTP and worker processes.
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV || env.NODE_ENV,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
      profilesSampleRate: env.NODE_ENV === 'production' ? 0.05 : 1.0,
      sendDefaultPii: false,
      beforeSendTransaction(event) {
        if (event.request) {
          delete event.request.headers;
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          if (event.request.url) event.request.url = event.request.url.split('?')[0];
        }
        for (const span of event.spans ?? []) {
          span.data = {};
          if (span.description) span.description = span.description.split('?')[0];
        }
        return event;
      },
      beforeSend(event) {
        if (event.request) {
          delete event.request.headers;
          delete event.request.cookies;
          delete event.request.data;
          delete event.request.query_string;
          if (event.request.url) event.request.url = event.request.url.split('?')[0];
        }
        return event;
      },
    });
  }
}
