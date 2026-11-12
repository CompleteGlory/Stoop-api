// Defaults for the end-to-end tests. Anything already in the environment wins,
// so CI can point them at its own services.
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '0',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/placerating_test',
  REDIS_URL: 'redis://localhost:6379/1',
  JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
  APPLE_BUNDLE_ID: 'com.example.PlaceRating',
  APPLE_TEAM_ID: 'ABCDE12345',
  SUPPORT_EMAIL: 'support@example.test',
  DEV_AUTH_ENABLED: 'false',
  // the fake S3 from docker-compose.yml
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'place-rating-test',
  S3_ACCESS_KEY_ID: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  S3_FORCE_PATH_STYLE: 'true',
  S3_AUTO_CREATE_BUCKET: 'true',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  EMAIL_AUTH_ENABLED: 'true',
  MAIL_PROVIDER: 'log',
  GOOGLE_CLIENT_IDS: 'test-client.apps.googleusercontent.com',
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
