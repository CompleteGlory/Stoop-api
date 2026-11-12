import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { HttpAppleTokenClient } from './apple-tokens.js';

describe('HttpAppleTokenClient', () => {
  it('signs the client secret Apple expects', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const config = {
      apple: {
        bundleId: 'com.example.App',
        signInKey: { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: await exportPKCS8(privateKey) },
      },
    } as unknown as AppConfig;
    const client = new HttpAppleTokenClient(config);
    expect(client.enabled).toBe(true);

    const now = new Date();
    const secret = await client.clientSecret(now);
    const { payload, protectedHeader } = await jwtVerify(secret, publicKey, { currentDate: now });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload).toMatchObject({ iss: 'TEAM123456', sub: 'com.example.App', aud: 'https://appleid.apple.com' });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it('is off without a key', () => {
    const client = new HttpAppleTokenClient({ apple: { bundleId: 'x', signInKey: null } } as unknown as AppConfig);
    expect(client.enabled).toBe(false);
  });
});
