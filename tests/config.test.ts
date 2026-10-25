import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadEnv } from '../src/config.js';

const VALID = {
  PORT: '8787',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PUBLIC_BASE_URL: 'https://sales-rescue.example.com',
  MCP_TOKEN: 'x'.repeat(48),
  OWNER_PIN: '482913',
  LOGISTICS_BASE_URL: 'http://127.0.0.1:8787/logistics',
  LOGISTICS_API_KEY: 'k'.repeat(32),
  PAYSTACK_SECRET_KEY: 'sk_test_abc123',
  PAYSTACK_BASE_URL: 'https://api.paystack.co',
  CHORD_BASE_URL: 'https://api.chordhq.xyz',
  CHORD_API_KEY: 'c'.repeat(32),
  CHORD_WORKSPACE_ID: 'ws-1',
  CHORD_TEAMMATE_ID: 'tm-1',
  WORKER_INTERVAL_MS: '15000',
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const withEnv = (env: Record<string, string | undefined>) => {
  for (const k of Object.keys(VALID)) delete process.env[k];
  Object.assign(process.env, env);
};

describe('environment validation', () => {
  it('accepts a complete, valid environment', () => {
    withEnv(VALID);
    const c = loadConfig();
    expect(c).toMatchObject({ port: 8787, workerIntervalMs: 15000, paystack: { secretKey: 'sk_test_abc123' } });
  });

  it('has no defaults: every missing variable is reported at once', () => {
    withEnv({});
    const err = (() => {
      try {
        loadConfig();
      } catch (e) {
        return (e as Error).message;
      }
    })();
    for (const k of Object.keys(VALID)) expect(err).toContain(`${k}: is not set`);
  });

  it('rejects live Paystack keys, short secrets and malformed values', () => {
    withEnv({ ...VALID, PAYSTACK_SECRET_KEY: 'sk_live_abc', MCP_TOKEN: 'short', OWNER_PIN: '12ab', PUBLIC_BASE_URL: 'https://x.com/' });
    const err = (() => {
      try {
        loadConfig();
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain('PAYSTACK_SECRET_KEY: must be a Paystack TEST key');
    expect(err).toContain('MCP_TOKEN: must be at least 32 characters');
    expect(err).toContain('OWNER_PIN: must be 4–12 digits');
    expect(err).toContain('PUBLIC_BASE_URL: must not end with a slash');
  });

  it('scripts can validate just the variables they use', () => {
    withEnv({ DATABASE_URL: VALID.DATABASE_URL, OWNER_PIN: VALID.OWNER_PIN });
    expect(loadEnv(['DATABASE_URL', 'OWNER_PIN'])).toEqual({ DATABASE_URL: VALID.DATABASE_URL, OWNER_PIN: VALID.OWNER_PIN });
  });
});
