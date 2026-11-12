export const APP_CONFIG = Symbol('APP_CONFIG');

const mailProviders = ['log', 'resend', 'brevo'] as const;
export type MailProvider = (typeof mailProviders)[number];

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  redisUrl: string;
  jwt: {
    secret: string;
    issuer: string;
    accessTtlSec: number;
    refreshTtlSec: number;
  };
  apple: {
    /** The iOS app's bundle id. Apple puts it in the `aud` claim of identity tokens. */
    bundleId: string;
    /** The developer team id. Universal links (`/.well-known/apple-app-site-association`) need it. null = off. */
    teamId: string | null;
    /** The Sign in with Apple key from the developer account, used to revoke tokens on deletion. null = off. */
    signInKey: { teamId: string; keyId: string; privateKey: string } | null;
  };
  /**
   * Apple push notifications (APNs). The key is a .p8 from the developer account with APNs enabled
   * (it can be the Sign in with Apple key when that one has APNs too). null = pushes are off.
   */
  apns: { teamId: string; keyId: string; privateKey: string } | null;
  nearby: {
    /** Friends closer than this (metres) get a "nearby" push. */
    radiusM: number;
    /** The same two friends are alerted at most once per this many seconds. */
    cooldownSec: number;
    /** How long a background position report is kept in Redis for the nearby check. */
    positionTtlSec: number;
  };
  /** Enables `POST /auth/dev`, a sign-in that skips Apple. Never allowed in production. */
  devAuthEnabled: boolean;
  google: {
    /** OAuth client ids whose Google ID tokens are accepted (the `aud` claim). Empty turns Google sign-in off. */
    clientIds: string[];
  };
  /** Shown on the terms and privacy pages as the contact address (App Review wants one). */
  supportEmail: string;
  email: {
    /** Email and password sign-up and sign-in. Off unless switched on. */
    enabled: boolean;
    /** `log` writes emails to the server log (development); `resend` and `brevo` send them. */
    provider: MailProvider;
    resendApiKey: string;
    brevoApiKey: string;
    /**
     * The sender, such as `Stoop <hello@your-domain>`. With Resend the domain must be verified there;
     * Brevo also accepts a single verified address (a Gmail one works, no domain needed).
     */
    from: string;
  };
  live: {
    /** Updates from one person closer together than this are dropped (spec: 1 per 2 s). */
    minLocIntervalMs: number;
    /** How often the server pings sockets; a socket that missed the previous ping is closed. */
    pingIntervalMs: number;
    /** How long a location lives in Redis without a new update. */
    locTtlSec: number;
  };
  s3: {
    /** Leave empty for AWS; set for R2, Railway buckets, a local S3 mock and similar. */
    endpoint: string | undefined;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    /** The public address of this API, without a trailing slash: photo URLs are `<this>/photos/<place>/<file>.jpg`. */
    publicBaseUrl: string;
    /** Create the bucket on startup when it is missing (development only). */
    autoCreateBucket: boolean;
  };
}

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

/**
 * Reads and validates the environment once. Every problem is collected so a
 * misconfigured deploy reports all of them at once instead of one per restart.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };

  const rawEnv = env.NODE_ENV ?? 'development';
  const nodeEnv = (
    ['development', 'test', 'production'].includes(rawEnv) ? rawEnv : 'development'
  ) as AppConfig['nodeEnv'];
  const isProd = nodeEnv === 'production';

  const port = int(env.PORT, 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push('PORT must be an integer between 0 and 65535');
  }

  const jwtSecret = need('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters');
  }
  // the repository is public, so the example value is known to everyone
  if (isProd && jwtSecret?.includes('change-me')) {
    problems.push('JWT_SECRET is still the example value from .env.example');
  }

  const devAuthEnabled = bool(env.DEV_AUTH_ENABLED, false);
  if (devAuthEnabled && isProd) {
    problems.push('DEV_AUTH_ENABLED must not be set in production');
  }

  const accessTtlSec = int(env.ACCESS_TOKEN_TTL_SEC, 15 * 60);
  const refreshTtlSec = int(env.REFRESH_TOKEN_TTL_SEC, 30 * 24 * 60 * 60);
  if (!(accessTtlSec > 0) || !(refreshTtlSec > 0)) {
    problems.push('ACCESS_TOKEN_TTL_SEC and REFRESH_TOKEN_TTL_SEC must be positive integers');
  }

  const config: AppConfig = {
    nodeEnv,
    port,
    databaseUrl: need('DATABASE_URL'),
    databaseSsl: bool(env.DATABASE_SSL, false),
    redisUrl: need('REDIS_URL'),
    jwt: {
      secret: jwtSecret,
      issuer: env.JWT_ISSUER || 'place-rating-api',
      accessTtlSec,
      refreshTtlSec,
    },
    apple: {
      bundleId: devAuthEnabled ? (env.APPLE_BUNDLE_ID ?? '') : need('APPLE_BUNDLE_ID'),
      teamId: env.APPLE_TEAM_ID?.trim() || null,
      signInKey:
        env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY
          ? {
              teamId: env.APPLE_TEAM_ID.trim(),
              keyId: env.APPLE_KEY_ID.trim(),
              // hosts often store the .p8 file on one line with literal \n
              privateKey: env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n').trim(),
            }
          : null,
    },
    apns:
      env.APPLE_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY
        ? {
            teamId: env.APPLE_TEAM_ID.trim(),
            keyId: env.APNS_KEY_ID.trim(),
            privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n').trim(),
          }
        : null,
    nearby: {
      radiusM: int(env.NEARBY_RADIUS_M, 500),
      cooldownSec: int(env.NEARBY_COOLDOWN_SEC, 3 * 3600),
      positionTtlSec: int(env.NEARBY_POSITION_TTL_SEC, 30 * 60),
    },
    devAuthEnabled,
    google: {
      clientIds: (env.GOOGLE_CLIENT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    },
    supportEmail: (env.SUPPORT_EMAIL || 'magddevf@gmail.com').trim(),
    email: {
      enabled: bool(env.EMAIL_AUTH_ENABLED, false),
      provider: mailProviders.find((p) => p === env.MAIL_PROVIDER) ?? 'log',
      resendApiKey: env.RESEND_API_KEY ?? '',
      brevoApiKey: env.BREVO_API_KEY ?? '',
      from: env.MAIL_FROM ?? '',
    },
    live: {
      minLocIntervalMs: int(env.LIVE_MIN_LOC_INTERVAL_MS, 2000),
      pingIntervalMs: int(env.LIVE_PING_INTERVAL_MS, 20000),
      locTtlSec: int(env.LIVE_LOC_TTL_SEC, 60),
    },
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY_ID'),
      secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
      // AVATAR_PUBLIC_BASE_URL is the old name, still read so existing deploys keep working
      publicBaseUrl: (env.PUBLIC_BASE_URL || env.AVATAR_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
      autoCreateBucket: bool(env.S3_AUTO_CREATE_BUCKET, false) && !isProd,
    },
  };

  const { minLocIntervalMs, pingIntervalMs, locTtlSec } = config.live;
  if (!(minLocIntervalMs >= 0) || !(pingIntervalMs > 0) || !(locTtlSec > 0)) {
    problems.push('LIVE_* settings must be integers (LIVE_MIN_LOC_INTERVAL_MS may be 0)');
  }
  if (!config.s3.publicBaseUrl) problems.push('PUBLIC_BASE_URL is required');
  if (Boolean(env.APPLE_KEY_ID) !== Boolean(env.APPLE_PRIVATE_KEY) || (env.APPLE_KEY_ID && !env.APPLE_TEAM_ID)) {
    problems.push('APPLE_KEY_ID and APPLE_PRIVATE_KEY go together and need APPLE_TEAM_ID');
  }
  if (Boolean(env.APNS_KEY_ID) !== Boolean(env.APNS_PRIVATE_KEY) || (env.APNS_KEY_ID && !env.APPLE_TEAM_ID)) {
    problems.push('APNS_KEY_ID and APNS_PRIVATE_KEY go together and need APPLE_TEAM_ID');
  }
  const { radiusM, cooldownSec, positionTtlSec } = config.nearby;
  if (!(radiusM > 0) || !(cooldownSec > 0) || !(positionTtlSec > 0)) {
    problems.push('NEARBY_* settings must be positive integers');
  }
  if (config.apple.teamId && !/^[A-Z0-9]{10}$/.test(config.apple.teamId)) {
    problems.push('APPLE_TEAM_ID must be the 10-character team id');
  }
  if (env.MAIL_PROVIDER && !mailProviders.some((p) => p === env.MAIL_PROVIDER)) {
    problems.push('MAIL_PROVIDER must be log, resend or brevo');
  }
  if (config.email.enabled && config.email.provider === 'resend' && (!config.email.resendApiKey || !config.email.from)) {
    problems.push('MAIL_PROVIDER=resend needs RESEND_API_KEY and MAIL_FROM');
  }
  if (config.email.enabled && config.email.provider === 'brevo') {
    if (!config.email.brevoApiKey || !config.email.from) {
      problems.push('MAIL_PROVIDER=brevo needs BREVO_API_KEY and MAIL_FROM');
    } else if (!parseSender(config.email.from)) {
      problems.push('MAIL_FROM must be an address, or Name <address>');
    }
  }
  // codes written to the log would let anyone with log access take over accounts
  if (isProd && config.email.enabled && config.email.provider === 'log') {
    problems.push('EMAIL_AUTH_ENABLED in production needs MAIL_PROVIDER=resend or brevo');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

/** Splits `Stoop <a@b.c>` (or a bare `a@b.c`) into name and address; null when it isn't one. */
export function parseSender(from: string): { name?: string; email: string } | null {
  const match = /^\s*(?:(.*?)\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(from);
  if (!match) return null;
  const name = match[1]?.replace(/^"|"$/g, '').trim();
  return { ...(name ? { name } : {}), email: match[2] ?? match[3] };
}
