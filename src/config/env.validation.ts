import { z } from 'zod';

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
    ALTCHA_HMAC_KEY: z.string().min(32, 'ALTCHA_HMAC_KEY must contain at least 32 characters'),

    // ─── Database (Prisma + PostgreSQL) ───────────────────────
    DATABASE_URL: z.string().startsWith('postgresql://', {
      message: 'DATABASE_URL must be a valid PostgreSQL connection string',
    }),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_SERVERLESS_POOL_MAX: z.coerce.number().int().min(1).max(10).default(1),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),

    // ─── Supabase (Auth + Storage only) ───────────────────────
    SUPABASE_URL: z.url({
      message: 'SUPABASE_URL must be a valid URL (e.g., https://your-project.supabase.co)',
    }),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
    SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
    SUPABASE_JWT_SECRET: z.string().optional(),

    // ─── Redis (Cache + Queue) ────────────────────────────────
    REDIS_URL: z
      .string()
      .refine((val) => val.startsWith('redis://') || val.startsWith('https://'), {
        message: 'REDIS_URL must start with redis:// (local) or https:// (Upstash)',
      }),
    UPSTASH_REDIS_TOKEN: z.string().optional(),

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
    PAYSTACK_PUBLIC_KEY: z.string().optional(),
    FLUTTERWAVE_SECRET_KEY: z.string().optional(),

    // ─── Church provider accounts and callback verification ───
    PUBLIC_API_URL: z.url().optional(),
    FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
    INTEGRATIONS_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .optional(),
    ),
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
    INTERNAL_PROXY_SECRET: z.string().min(32).optional(),
    MAX_FILE_SIZE_MB: z.coerce.number().default(5),

    // AES-256-GCM key for encrypting pastoral note content at rest
    PASTORAL_ENCRYPTION_KEY: z
      .string()
      .min(16, 'PASTORAL_ENCRYPTION_KEY must be at least 16 characters')
      .optional(),

    // Dedicated 32-byte hex key; no development fallback for authenticator secrets.
    TWO_FACTOR_ENCRYPTION_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/, 'TWO_FACTOR_ENCRYPTION_KEY must be 64 hexadecimal characters')
        .optional(),
    ),

    // ─── Monitoring (Optional) ────────────────────────────────
    SENTRY_DSN: z.string().optional(),
  })
  .superRefine((value, ctx) => {
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
  const parsed = envSchema.safeParse(process.env);

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
