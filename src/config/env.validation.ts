import { normalizeSecret, previousSecrets, SECRET_RULES, SecretName } from './secret-keys';
import { z } from 'zod';
import { databasePoolDefaults } from '../prisma/pool-config';

const databaseDefaults = databasePoolDefaults(process.env);

// Empty feature-key slots are unconfigured; production requirements still apply.
function optionalSetting<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

function secretSetting(name: SecretName) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .transform((value, ctx) => {
        try {
          return normalizeSecret(name, value)!;
        } catch (error) {
          ctx.addIssue({ code: 'custom', message: (error as Error).message });
          return z.NEVER;
        }
      })
      .optional(),
  );
}
function previousSetting(name: SecretName) {
  return optionalSetting(
    z.string().superRefine((value, ctx) => {
      try {
        previousSecrets(name, value);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `${name}_PREVIOUS_KEYS must be a JSON array of at most 5 valid, nonempty keys`,
        });
      }
    }),
  );
}

/**
 * Zod schema for validating environment variables at application startup.
 *
 * This ensures all required environment variables are present and properly formatted
 * before the application starts. Fails fast with descriptive error messages.
 *
 * @see .env.example for the full list of environment variables
 */

const envSchema = z
  .object({
    // ─── Application ──────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WEB_URL: z.url().default('http://localhost:3000'),
    ALTCHA_HMAC_KEY: secretSetting('ALTCHA_HMAC_KEY'),
    ALTCHA_HMAC_KEY_PREVIOUS_KEYS: previousSetting('ALTCHA_HMAC_KEY'),

    // ─── Database (Prisma + PostgreSQL) ───────────────────────
    DATABASE_URL: z.string().startsWith('postgresql://', {
      message: 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(databaseDefaults.persistentMax),
    DB_SERVERLESS_POOL_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(databaseDefaults.serverlessMax),
    DB_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .default(databaseDefaults.idleTimeoutMillis),
    DB_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(databaseDefaults.connectionTimeoutMillis),

    // ─── Supabase (Auth + Storage only) ───────────────────────
    SUPABASE_URL: z.url({
      message: 'SUPABASE_URL must be a valid URL (e.g., https://your-project.supabase.co)',
    }),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
    SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),

    // ─── Redis (Cache + Queue) ────────────────────────────────
    REDIS_URL: z
      .string()
      .refine(
        (val) =>
          val.startsWith('redis://') || val.startsWith('rediss://') || val.startsWith('https://'),
        {
          message: 'REDIS_URL must start with redis://, rediss:// or https:// (Upstash)',
        },
      ),
    UPSTASH_REDIS_TOKEN: z.string().optional(),
    QUEUE_REDIS_URL: optionalSetting(
      z.string().refine(
        (value) => {
          try {
            const url = new URL(value);
            return ['redis:', 'rediss:'].includes(url.protocol) && !!url.hostname;
          } catch {
            return false;
          }
        },
        { message: 'QUEUE_REDIS_URL must be a Redis TCP/TLS connection string' },
      ),
    ),
    REDIS_NAMESPACE: optionalSetting(
      z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]{1,64}$/,
          'REDIS_NAMESPACE must contain 1 to 64 letters, numbers, underscores or hyphens',
        ),
    ),

    // ─── Payments (Optional for MVP, required for production) ─
    SUBSCRIPTION_PAYSTACK_CURRENCIES: z
      .string()
      .regex(/^(NGN|USD|GHS|KES|ZAR)(,(NGN|USD|GHS|KES|ZAR))*$/)
      .default('NGN'),
    SUBSCRIPTION_FLUTTERWAVE_CURRENCIES: z
      .string()
      .regex(
        /^(USD|NGN|EUR|GBP|CAD|GHS|KES|ZAR|UGX|XAF|XOF)(,(USD|NGN|EUR|GBP|CAD|GHS|KES|ZAR|UGX|XAF|XOF))*$/,
      )
      .default('NGN'),
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    FLUTTERWAVE_SECRET_KEY: z.string().optional(),

    // ─── Church provider accounts and callback verification ───
    PUBLIC_API_URL: optionalSetting(z.url()),
    FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
    INTEGRATIONS_ENCRYPTION_KEY: secretSetting('INTEGRATIONS_ENCRYPTION_KEY'),
    INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS: previousSetting('INTEGRATIONS_ENCRYPTION_KEY'),
    ENABLE_SMS_FALLBACK: z
      .preprocess((value) => value === true || value === 'true', z.boolean())
      .default(false),

    // ─── Email (Resend) ───────────────────────────────────────
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM: z.string().default('noreply@churchos.app'),

    // ─── AI (Optional) ────────────────────────────────────────
    OPENAI_API_KEY: z.string().optional(),

    // ─── Storage (Supabase Storage) ──────────────────────────
    SUPABASE_STORAGE_BUCKET: z.string().default('media'),
    SUPABASE_PRIVATE_STORAGE_BUCKET: z.string().default('media-private'),
    MEDIA_UPLOAD_SIGNING_KEY: secretSetting('MEDIA_UPLOAD_SIGNING_KEY'),
    MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS: previousSetting('MEDIA_UPLOAD_SIGNING_KEY'),
    INTERNAL_PROXY_SECRET: secretSetting('INTERNAL_PROXY_SECRET'),
    INTERNAL_PROXY_SECRET_PREVIOUS_KEYS: previousSetting('INTERNAL_PROXY_SECRET'),
    PASTORAL_ENCRYPTION_KEY: secretSetting('PASTORAL_ENCRYPTION_KEY'),
    PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS: previousSetting('PASTORAL_ENCRYPTION_KEY'),
    TWO_FACTOR_ENCRYPTION_KEY: secretSetting('TWO_FACTOR_ENCRYPTION_KEY'),
    TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS_KEYS: previousSetting('TWO_FACTOR_ENCRYPTION_KEY'),

    // ─── Monitoring (Optional) ────────────────────────────────
    SENTRY_DSN: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.ALTCHA_HMAC_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['ALTCHA_HMAC_KEY'],
        message: 'ALTCHA_HMAC_KEY is required (at least 32 characters)',
      });
    for (const name of Object.keys(SECRET_RULES) as SecretName[]) {
      try {
        if (!value[name] && previousSecrets(name, value[`${name}_PREVIOUS_KEYS`]).length)
          ctx.addIssue({
            code: 'custom',
            path: [`${name}_PREVIOUS_KEYS`],
            message: `Configure ${name} before previous keys`,
          });
      } catch {
        /* The field validator reports invalid lists. */
      }
    }
    if (value.NODE_ENV === 'production' && value.PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS) {
      try {
        if (
          previousSecrets(
            'PASTORAL_ENCRYPTION_KEY',
            value.PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS,
          ).includes('dev-only-change-in-production-32b')
        )
          ctx.addIssue({
            code: 'custom',
            path: ['PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS'],
            message: 'Development fallback keys cannot be retained in production',
          });
      } catch {
        /* The field validator reports invalid lists. */
      }
    }
    if (
      value.NODE_ENV === 'production' &&
      (!value.PASTORAL_ENCRYPTION_KEY ||
        value.PASTORAL_ENCRYPTION_KEY === 'dev-only-change-in-production-32b')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PASTORAL_ENCRYPTION_KEY'],
        message: 'A dedicated pastoral encryption key is required in production',
      });
    }
  });

/**
 * Parsed and validated environment variables.
 * Use this instead of `process.env` for type-safe access.
 *
 * @example
 * ```typescript
 * import { env } from './config/env.validation';
 *
 * console.log(env.DATABASE_URL); // Type-safe, validated
 * ```
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Validates process.env against the schema and returns typed env object.
 * Throws a descriptive error if validation fails.
 */
function validateEnv(): Env {
  const settings = { ...process.env };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ASK_CHURCHOS_')) {
      const current = key.replace('ASK_CHURCHOS_', 'ASK_BELIVRHQ_');
      if (settings[current] === undefined) settings[current] = value;
    }
  }
  const parsed = envSchema.safeParse(settings);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(parsed.error.format());
    process.exit(1);
  }

  return parsed.data;
}

/**
 * Validated environment variables.
 * Accessed throughout the application for type-safe env access.
 */
export const env = validateEnv();
