import { decodeJwt, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { Http2ApnsClient } from './apns.client.js';
import { pushMessage } from './push.service.js';

describe('Http2ApnsClient', () => {
  it('signs the provider token APNs expects and reuses it for a while', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const config = {
      apple: { bundleId: 'com.example.App' },
      apns: { teamId: 'TEAM123456', keyId: 'PUSH123456', privateKey: await exportPKCS8(privateKey) },
    } as unknown as AppConfig;
    const client = new Http2ApnsClient(config);
    expect(client.enabled).toBe(true);

    const now = Date.now();
    const token = await client.authToken(now);
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: 'PUSH123456' });
    expect(payload).toEqual({ iss: 'TEAM123456', iat: Math.floor(now / 1000) });

    expect(await client.authToken(now + 30 * 60_000)).toBe(token);
    const renewed = await client.authToken(now + 50 * 60_000);
    expect(decodeJwt(renewed).iat).toBe(Math.floor((now + 50 * 60_000) / 1000));
  });

  it('is off without a key', () => {
    const client = new Http2ApnsClient({ apple: { bundleId: 'x' }, apns: null } as unknown as AppConfig);
    expect(client.enabled).toBe(false);
  });
});

describe('pushMessage', () => {
  it('leaves the wording to the app and collapses repeats from the same person', () => {
    const message = pushMessage('nearby', { id: 'u1', name: 'Sara' });
    expect(message).toEqual({
      payload: {
        aps: {
          alert: { 'title-loc-key': 'Friend nearby', 'loc-key': '%@ is nearby', 'loc-args': ['Sara'] },
          sound: 'default',
          'thread-id': 'nearby',
        },
        kind: 'nearby',
        userId: 'u1',
      },
      collapseId: 'nearby:u1',
    });
  });
});
