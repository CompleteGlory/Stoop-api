import { loadConfig } from './app-config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  APPLE_BUNDLE_ID: 'com.example.App',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  PUBLIC_BASE_URL: 'https://cdn.example.com/bucket/',
};

describe('loadConfig', () => {
  it('reads a complete environment and applies the spec defaults', () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      jwt: { accessTtlSec: 900, refreshTtlSec: 2_592_000 },
      live: { minLocIntervalMs: 2000, pingIntervalMs: 20000, locTtlSec: 60 },
      devAuthEnabled: false,
      s3: { publicBaseUrl: 'https://cdn.example.com/bucket', forcePathStyle: false },
    });
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      loadConfig({});
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'APPLE_BUNDLE_ID', 'S3_BUCKET', 'PUBLIC_BASE_URL']) {
      expect(message).toContain(`${name} is required`);
    }
  });

  it('wants a long JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/at least 32 characters/);
  });

  it('refuses the example JWT secret in production', () => {
    const example = { ...valid, JWT_SECRET: 'change-me-to-a-long-random-string-of-32+chars' };
    expect(() => loadConfig({ ...example, NODE_ENV: 'production' })).toThrow(/example value/);
    expect(() => loadConfig(example)).not.toThrow();
  });

  it('refuses the dev sign-in in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true' })).toThrow(
      /DEV_AUTH_ENABLED must not be set in production/,
    );
    expect(loadConfig({ ...valid, NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' }).devAuthEnabled).toBe(true);
  });

  it('does not create buckets in production', () => {
    const env = { ...valid, S3_AUTO_CREATE_BUCKET: 'true' };
    expect(loadConfig({ ...env, NODE_ENV: 'development' }).s3.autoCreateBucket).toBe(true);
    expect(loadConfig({ ...env, NODE_ENV: 'production' }).s3.autoCreateBucket).toBe(false);
  });

  it('rejects malformed numbers', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...valid, LIVE_PING_INTERVAL_MS: '0' })).toThrow(/LIVE_/);
    expect(loadConfig({ ...valid, LIVE_MIN_LOC_INTERVAL_MS: '0' }).live.minLocIntervalMs).toBe(0);
  });

  it('keeps email sign-in off by default and reads Google client ids', () => {
    const c = loadConfig({ ...valid, GOOGLE_CLIENT_IDS: ' a.apps.googleusercontent.com , b ' });
    expect(c.email).toMatchObject({ enabled: false, provider: 'log' });
    expect(c.google.clientIds).toEqual(['a.apps.googleusercontent.com', 'b']);
    expect(loadConfig(valid).google.clientIds).toEqual([]);
  });

  it('refuses email codes in the log in production, and Resend without its settings', () => {
    const prod = { ...valid, NODE_ENV: 'production', EMAIL_AUTH_ENABLED: 'true' };
    expect(() => loadConfig(prod)).toThrow(/MAIL_PROVIDER=resend/);
    expect(() => loadConfig({ ...prod, MAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY and MAIL_FROM/);
    expect(
      loadConfig({ ...prod, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', MAIL_FROM: 'Stoop <a@b.c>' }).email.enabled,
    ).toBe(true);
    expect(() => loadConfig({ ...valid, MAIL_PROVIDER: 'pigeon' })).toThrow(/MAIL_PROVIDER/);
  });

  it('still reads the old AVATAR_PUBLIC_BASE_URL name', () => {
    const { PUBLIC_BASE_URL: _omit, ...old } = valid;
    expect(loadConfig({ ...old, AVATAR_PUBLIC_BASE_URL: 'https://api.example.com/' }).s3.publicBaseUrl).toBe(
      'https://api.example.com',
    );
  });

  it('only needs the Apple bundle id when the dev sign-in is off', () => {
    const { APPLE_BUNDLE_ID: _omit, ...withoutBundle } = valid;
    expect(() => loadConfig(withoutBundle)).toThrow(/APPLE_BUNDLE_ID/);
    expect(() => loadConfig({ ...withoutBundle, DEV_AUTH_ENABLED: 'true' })).not.toThrow();
  });
});
