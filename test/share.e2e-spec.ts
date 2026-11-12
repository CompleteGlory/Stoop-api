import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetState, signUp } from './helpers.js';

describe('shared place links', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState(app);
  });

  async function makePlace(name = 'Café <Riche> & "Co"') {
    const nia = await signUp(app, 'nia');
    const auth = { Authorization: `Bearer ${nia.accessToken}` };
    const place = (
      await api()
        .post('/places/resolve')
        .set(auth)
        .send({ name, category: 'MKPOICategoryCafe', latitude: 30.0504, longitude: 31.2466 })
        .expect(200)
    ).body;
    return { place, auth };
  }

  it('tells iOS that /p/* links open the app', async () => {
    const res = await api().get('/.well-known/apple-app-site-association').expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      applinks: {
        details: [{ appIDs: ['ABCDE12345.com.example.PlaceRating'], components: [{ '/': '/p/*', comment: 'A shared place' }] }],
      },
    });
  });

  it('serves a public page with the place, its rating and map links, without a token', async () => {
    const { place, auth } = await makePlace();
    await api().put(`/places/${place.id}/rating`).set(auth).send({ stars: 4, comment: 'secret words' }).expect(200);

    const res = await api().get(`/p/${place.id}`).expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    // the name is escaped everywhere it appears
    expect(res.text).toContain('Café &lt;Riche&gt; &amp; &quot;Co&quot;');
    expect(res.text).not.toContain('<Riche>');
    expect(res.text).toContain('<meta property="og:title"');
    expect(res.text).toContain('★ 4.0 · 1 rating · Cafe');
    expect(res.text).toContain(`stoop://place/${place.id}`);
    expect(res.text).toContain('https://www.google.com/maps/search/?api=1&amp;query=30.0504,31.2466');
    expect(res.text).toContain('https://maps.apple.com/?ll=30.0504,31.2466');
    // nothing about people: no comments, no usernames
    expect(res.text).not.toContain('secret words');
    expect(res.text).not.toContain('nia');
  });

  it('speaks Arabic to Arabic browsers', async () => {
    const { place } = await makePlace('Riche');
    const res = await api().get(`/p/${place.id}`).set('Accept-Language', 'ar-EG,ar;q=0.9').expect(200);
    expect(res.text).toContain('dir="rtl"');
    expect(res.text).toContain('افتح في خرائط Google');
  });

  it('answers unknown and malformed ids with a not-found page', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await api().get(`/p/${id}`).expect(404);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('This place isn’t on Stoop');
    }
  });
});
