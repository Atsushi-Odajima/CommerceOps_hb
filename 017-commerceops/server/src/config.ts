import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  DATABASE_SSL: boolish.default(false),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  SESSION_IDLE_HOURS: z.coerce.number().min(1).max(168).default(12),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().min(1).max(90).default(7),
  COOKIE_SECURE: boolish.optional(),
  TRUST_PROXY: boolish.default(false),
  WEB_DIST_DIR: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  RUN_WORKER: boolish.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(1200),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  MAX_UPLOAD_MB: z.coerce.number().min(1).max(100).default(20),
  ALLOW_SIGNUP: boolish.default(false),
});

export type AppConfig = z.infer<typeof ConfigSchema> & { cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Record<string, unknown>> = {}): AppConfig {
  const parsed = ConfigSchema.safeParse({ ...env, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  return { ...c, cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
