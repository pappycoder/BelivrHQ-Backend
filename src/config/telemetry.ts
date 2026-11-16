import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import type { Env } from './env.validation';
import { redactTelemetry } from './telemetry-privacy';

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
      // Transaction privacy hooks require static lifecycle in the installed SDK.
      traceLifecycle: 'static',
      beforeSendTransaction: redactTelemetry,
      beforeSend: redactTelemetry,
    });
  }
}
