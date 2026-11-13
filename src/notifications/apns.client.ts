import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { connect, type ClientHttp2Session } from 'node:http2';
import { APP_CONFIG, type ApnsKey, type AppConfig } from '../config/app-config.js';
import type { PushEnvironment } from '../db/entities/push-device.entity.js';

export interface PushTarget {
  token: string;
  environment: PushEnvironment;
}

export interface PushMessage {
  /** The APNs payload: `aps` plus Stoop's own keys, which the app reads when the notification is tapped. */
  payload: Record<string, unknown>;
  /** Pushes with the same id replace each other on the lock screen. */
  collapseId?: string;
}

/** `unregistered`: Apple says the token is dead (app removed, wrong environment); forget it. */
export type PushResult = 'sent' | 'unregistered' | 'failed';

/**
 * Sends one notification to one device through Apple's push service.
 * Abstract so tests need no network. Tokens are never logged.
 */
export abstract class ApnsClient {
  /** False until the APNs key is configured; devices still register, nothing is sent. */
  abstract readonly enabled: boolean;
  abstract send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}

const HOSTS: Record<PushEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
/** Apple wants the provider token refreshed at most every 20 and at least every 60 minutes. */
const PROVIDER_TOKEN_TTL_MS = 45 * 60 * 1000;
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

/**
 * APNs over HTTP/2 with token (.p8 key) authentication. Each environment has its own kept-open
 * connection and its own key: Apple refuses a connection that mixes keys from two environments.
 */
@Injectable()
export class Http2ApnsClient extends ApnsClient implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsClient.name);
  private readonly sessions = new Map<PushEnvironment, ClientHttp2Session>();
  private readonly providerTokens = new Map<PushEnvironment, { value: string; at: number }>();
  private readonly keys = new Map<PushEnvironment, Promise<CryptoKey>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  get enabled(): boolean {
    return this.config.apns.production !== null || this.config.apns.sandbox !== null;
  }

  private keyFor(environment: PushEnvironment): ApnsKey | null {
    return this.config.apns[environment];
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    // no key for this device's environment (say, an Xcode build while only production is set up)
    if (!this.keyFor(target.environment)) return 'failed';
    const token = await this.authToken(target.environment);
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${target.token}`,
      authorization: `bearer ${token}`,
      'apns-topic': this.config.apple.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // a friend request is still worth showing tomorrow; Apple keeps it while the phone is off
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
      'content-type': 'application/json',
    };
    if (message.collapseId) headers['apns-collapse-id'] = message.collapseId;

    const { status, reason } = await this.post(target.environment, headers, JSON.stringify(message.payload));
    if (status === 200) return 'sent';
    if (status === 410 || (status === 400 && DEAD_TOKEN_REASONS.has(reason))) return 'unregistered';
    if (status === 403 && reason === 'ExpiredProviderToken') this.providerTokens.delete(target.environment);
    this.logger.warn(`APNs ${target.environment} answered ${status || 'no response'}${reason ? ` (${reason})` : ''}`);
    return 'failed';
  }

  onModuleDestroy() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private post(environment: PushEnvironment, headers: Record<string, string>, body: string) {
    return new Promise<{ status: number; reason: string }>((resolve) => {
      let status = 0;
      let text = '';
      const done = () => {
        let reason = '';
        try {
          reason = text ? String(JSON.parse(text).reason ?? '') : '';
        } catch {
          // not JSON
        }
        resolve({ status, reason });
      };
      try {
        const req = this.session(environment).request(headers);
        req.setEncoding('utf8');
        req.setTimeout(10_000, () => req.close());
        req.on('response', (h) => (status = Number(h[':status'] ?? 0)));
        req.on('data', (chunk: string) => (text += chunk));
        req.on('end', done);
        req.on('error', done);
        req.on('close', done);
        req.end(body);
      } catch {
        resolve({ status: 0, reason: '' });
      }
    });
  }

  private session(environment: PushEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(HOSTS[environment]);
    const forget = () => {
      if (this.sessions.get(environment) === session) this.sessions.delete(environment);
    };
    session.on('error', forget);
    session.on('close', forget);
    session.on('goaway', forget);
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  /** The provider token: an ES256 JWT signed with that environment's APNs key, reused for 45 minutes. */
  async authToken(environment: PushEnvironment, now = Date.now()): Promise<string> {
    const apns = this.keyFor(environment);
    if (!apns) throw new Error(`No APNs key is configured for ${environment}`);
    const cached = this.providerTokens.get(environment);
    if (cached && now - cached.at < PROVIDER_TOKEN_TTL_MS) return cached.value;
    let key = this.keys.get(environment);
    if (!key) {
      key = importPKCS8(apns.privateKey, 'ES256');
      this.keys.set(environment, key);
    }
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: apns.keyId })
      .setIssuer(apns.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(await key);
    this.providerTokens.set(environment, { value, at: now });
    return value;
  }
}
