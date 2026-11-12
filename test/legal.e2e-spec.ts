import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers.js';

describe('terms and privacy pages', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  for (const path of ['/terms', '/privacy']) {
    it(`serves ${path} as HTML without a token`, async () => {
      const res = await api().get(path).expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('<html lang="en"');
      expect(res.text).toContain('Stoop');
      // English and Arabic on one page, the Arabic part right to left
      expect(res.text).toContain('dir="rtl"');
      // the support address from the configuration, as a mailto link
      expect(res.text).toContain('mailto:support@example.test');
    });
  }

  it('says what the app really does with location and with deleting an account', async () => {
    const privacy = (await api().get('/privacy').expect(200)).text;
    expect(privacy).toMatch(/60 seconds/);
    expect(privacy).toMatch(/Nearby alerts \(only if you turn them on\)/);
    expect(privacy).toMatch(/30 minutes/);
    expect(privacy).toMatch(/Delete account/);
    expect(privacy).toMatch(/never stored|not stored/i);
    const terms = (await api().get('/terms').expect(200)).text;
    expect(terms).toMatch(/report/i);
    expect(terms).toMatch(/block/i);
  });

  it('is cacheable for a short time and escapes nothing user-supplied', async () => {
    const res = await api().get('/terms').expect(200);
    expect(res.headers['cache-control']).toContain('max-age=');
    expect(res.text).not.toContain('undefined');
  });
});
