import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { StorageService } from '../src/users/storage.service.js';
import { createTestApp, resetState, signUp } from './helpers.js';

/** Needs an S3-compatible server on S3_ENDPOINT: the moto container from docker-compose.yml. */
describe('avatar photos (S3 presigned upload)', () => {
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

  async function photo(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
    const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } });
    // EXIF with a GPS-free but recognisable Make tag, to prove metadata does not survive
    const buf = await (format === 'jpeg'
      ? image.jpeg().withExif({ IFD0: { Make: 'SecretCam' } }).toBuffer()
      : image.png().toBuffer());
    return buf;
  }

  async function upload(user: { auth: { Authorization: string } }, body: Buffer, contentType = 'image/jpeg') {
    const presign = await api()
      .post('/me/avatar/upload-url')
      .set(user.auth)
      .send({ contentType, contentLength: body.length })
      .expect(200);
    const put = await fetch(presign.body.uploadUrl, {
      method: presign.body.method,
      headers: presign.body.headers,
      body: new Uint8Array(body),
    });
    expect(put.status).toBe(200);
    return presign.body.key as string;
  }

  it('uploads, re-encodes to a 256 px JPEG without metadata, and serves it from a public URL', async () => {
    const alice = await signUp(app, 'alice');
    const original = await photo(800, 600);
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const key = await upload(alice, original);
    expect(key.startsWith(`uploads/${alice.id}/`)).toBe(true);

    const me = await api().post('/me/avatar/confirm').set(alice.auth).send({ key }).expect(200);
    expect(me.body.avatar.kind).toBe('upload');
    expect(me.body.avatar.value).toMatch(new RegExp(`^avatars/${alice.id}/[0-9a-f-]+\\.jpg$`));
    expect(me.body.avatar.url).toBe(`${process.env.AVATAR_PUBLIC_BASE_URL}/${me.body.avatar.value}`);

    // the app downloads the picture from this URL, without credentials: the API streams it from the bucket
    const served = await api().get(`/${me.body.avatar.value}`).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['cache-control']).toContain('immutable');
    const bytes = served.body as Buffer;
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 256, height: 256 });
    expect(meta.exif).toBeUndefined();

    // the temporary upload is gone
    expect(await app.get(StorageService).size(key)).toBeNull();
  });

  it('serves only processed avatars: unknown files, bad ids and unchecked uploads are refused', async () => {
    const alice = await signUp(app, 'alice');
    const key = await upload(alice, await photo(200, 200));
    // an upload that was not confirmed yet is not reachable through the public route
    await api().get(`/${key}`).expect(404);
    const me = await api().post('/me/avatar/confirm').set(alice.auth).send({ key }).expect(200);

    const [, userId, file] = me.body.avatar.value.split('/');
    await api().get(`/avatars/${userId}/${file}`).expect(200);
    await api().get(`/avatars/${userId}/00000000-0000-4000-8000-000000000000.jpg`).expect(404);
    await api().get(`/avatars/${userId}/${file.replace('.jpg', '.png')}`).expect(404);
    await api().get(`/avatars/${userId}/..%2F..%2Fuploads%2Fx`).expect(404);
    const bad = await api().get(`/avatars/not-a-uuid/${file}`).expect(400);
    expect(bad.body.error.code).toBe('invalid_id');
  });

  it('replaces the old photo when a new one is confirmed and when a preset is chosen', async () => {
    const alice = await signUp(app, 'alice');
    const first = await api()
      .post('/me/avatar/confirm')
      .set(alice.auth)
      .send({ key: await upload(alice, await photo(300, 300)) })
      .expect(200);
    const second = await api()
      .post('/me/avatar/confirm')
      .set(alice.auth)
      .send({ key: await upload(alice, await photo(400, 300, 'png'), 'image/png') })
      .expect(200);
    const storage = app.get(StorageService);
    expect(await storage.size(first.body.avatar.value)).toBeNull();
    await api().get(`/${first.body.avatar.value}`).expect(404);
    expect(await storage.size(second.body.avatar.value)).toBeGreaterThan(0);
    await api().get(`/${second.body.avatar.value}`).expect(200);

    await api().patch('/me').set(alice.auth).send({ avatarPreset: 'panda' }).expect(200);
    expect(await storage.size(second.body.avatar.value)).toBeNull();
  });

  it('refuses things that are not pictures, other people’s uploads and bad requests', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');

    const notAnImage = await upload(alice, Buffer.from('definitely not a jpeg, just some text'));
    const bad = await api().post('/me/avatar/confirm').set(alice.auth).send({ key: notAnImage }).expect(422);
    expect(bad.body.error.code).toBe('invalid_image');

    const bobsKey = await upload(bob, await photo(100, 100));
    const stolen = await api().post('/me/avatar/confirm').set(alice.auth).send({ key: bobsKey }).expect(400);
    expect(stolen.body.error.code).toBe('invalid_key');

    await api()
      .post('/me/avatar/confirm')
      .set(alice.auth)
      .send({ key: `uploads/${alice.id}/does-not-exist` })
      .expect(404);

    await api().post('/me/avatar/upload-url').set(alice.auth).send({ contentType: 'image/gif', contentLength: 10 }).expect(400);
    await api()
      .post('/me/avatar/upload-url')
      .set(alice.auth)
      .send({ contentType: 'image/jpeg', contentLength: 6 * 1024 * 1024 })
      .expect(400);
    await api().post('/me/avatar/upload-url').send({ contentType: 'image/jpeg', contentLength: 10 }).expect(401);
  });
});
