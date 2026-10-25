import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Local .env for development; on Railway the variables come from the platform. quiet: dotenv 18
// otherwise prints a banner to stdout, which would corrupt JSON logs and piped values.
loadDotenv({ quiet: true });

/**
 * Every environment variable, validated before anything starts. There are no defaults: a missing
 * or malformed value stops the process with a list of every problem, instead of running with a
 * guess (e.g. talking to the wrong database or Paystack in live mode).
 */
const url = z.string().url();
const secret = (min: number) => z.string().min(min, `must be at least ${min} characters`);

export const envSchema = {
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  PUBLIC_BASE_URL: url.refine((u) => !u.endsWith('/'), 'must not end with a slash'),
  MCP_TOKEN: secret(32),
  OWNER_PIN: z.string().regex(/^\d{4,12}$/, 'must be 4–12 digits'),
  LOGISTICS_BASE_URL: url,
  LOGISTICS_API_KEY: secret(16),
  PAYSTACK_SECRET_KEY: z.string().startsWith('sk_test_', 'must be a Paystack TEST key (sk_test_…)'),
  PAYSTACK_BASE_URL: url,
  CHORD_BASE_URL: url,
  CHORD_API_KEY: secret(16),
  CHORD_WORKSPACE_ID: z.string().min(1),
  CHORD_TEAMMATE_ID: z.string().min(1),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000),
};

export type EnvKey = keyof typeof envSchema;

/** Validate the given variables (all of them by default) and return them typed. */
export function loadEnv<K extends EnvKey>(keys: readonly K[] = Object.keys(envSchema) as K[]) {
  const shape = Object.fromEntries(keys.map((k) => [k, envSchema[k]])) as { [P in K]: (typeof envSchema)[P] };
  const parsed = z.object(shape).safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.')}: ${process.env[String(i.path[0])] === undefined ? 'is not set' : i.message}`,
    );
    throw new Error(`Invalid environment (see .env.example):\n${problems.join('\n')}`);
  }
  return parsed.data as { [P in K]: z.infer<(typeof envSchema)[P]> };
}

/** Full server configuration. Call once at startup. */
export function loadConfig() {
  const e = loadEnv();
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    mcpToken: e.MCP_TOKEN,
    ownerPin: e.OWNER_PIN,
    logistics: { baseUrl: e.LOGISTICS_BASE_URL, apiKey: e.LOGISTICS_API_KEY },
    paystack: { secretKey: e.PAYSTACK_SECRET_KEY, baseUrl: e.PAYSTACK_BASE_URL },
    chord: { baseUrl: e.CHORD_BASE_URL, apiKey: e.CHORD_API_KEY, workspaceId: e.CHORD_WORKSPACE_ID, teammateId: e.CHORD_TEAMMATE_ID },
    workerIntervalMs: e.WORKER_INTERVAL_MS,
  };
}

export type Config = ReturnType<typeof loadConfig>;
