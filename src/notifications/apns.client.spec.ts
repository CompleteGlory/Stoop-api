import { decodeJwt, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { Http2ApnsClient } from './apns.client.js';
import { pushMessage } from './push.service.js';

describe('Http2ApnsClient', () => {
  it('signs the provider token APNs expects and reuses it for a while', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const sandboxPair = await generateKeyPair('ES256', { extractable: true });
    const config = {
      apple: { bundleId: 'com.example.App' },
      apns: {
        production: { teamId: 'TEAM123456', keyId: 'PUSH123456', privateKey: await exportPKCS8(privateKey) },
        sandbox: { teamId: 'TEAM123456', keyId: 'SAND123456', privateKey: await exportPKCS8(sandboxPair.privateKey) },
      },
    } as unknown as AppConfig;
    const client = new Http2ApnsClient(config);
    expect(client.enabled).toBe(true);

    const now = Date.now();
    const token = await client.authToken('production', now);
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: 'PUSH123456' });
    expect(payload).toEqual({ iss: 'TEAM123456', iat: Math.floor(now / 1000) });

    expect(await client.authToken('production', now + 30 * 60_000)).toBe(token);
    const renewed = await client.authToken('production', now + 50 * 60_000);
    expect(decodeJwt(renewed).iat).toBe(Math.floor((now + 50 * 60_000) / 1000));

    // sandbox devices get a token from the sandbox key, never the production one
    const sandbox = await jwtVerify(await client.authToken('sandbox', now), sandboxPair.publicKey);
    expect(sandbox.protectedHeader).toEqual({ alg: 'ES256', kid: 'SAND123456' });
  });

  it('is off without a key, and sends nothing to an environment that has none', async () => {
    const none = { apple: { bundleId: 'x' }, apns: { production: null, sandbox: null } } as unknown as AppConfig;
    expect(new Http2ApnsClient(none).enabled).toBe(false);

    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const productionOnly = {
      apple: { bundleId: 'x' },
      apns: { production: { teamId: 'T', keyId: 'K', privateKey: await exportPKCS8(privateKey) }, sandbox: null },
    } as unknown as AppConfig;
    const client = new Http2ApnsClient(productionOnly);
    expect(client.enabled).toBe(true);
    expect(await client.send({ token: 'ab', environment: 'sandbox' }, { payload: {} })).toBe('failed');
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
