import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { StorageService } from '../src/common/storage.service.js';
import { befriend, createTestApp, downtown, resetState, signUp, type TestUser } from './helpers.js';

/** Needs an S3-compatible server on S3_ENDPOINT: the moto container from docker-compose.yml. */
describe('place photos (S3 presigned upload)', () => {
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

  async function picture(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
    const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } });
    // EXIF with a recognisable Make tag, to prove metadata does not survive
    return format === 'jpeg' ? image.jpeg().withExif({ IFD0: { Make: 'SecretCam' } }).toBuffer() : image.png().toBuffer();
  }

  async function aPlace(user: TestUser, appleId = 'photo-place') {
    const res = await api().post('/places/resolve').set(user.auth).send({ appleId, name: 'Cafe Photo', ...downtown }).expect(200);
    return res.body.id as string;
  }

  async function upload(user: TestUser, placeId: string, body: Buffer, contentType = 'image/jpeg') {
    const presign = await api()
      .post(`/places/${placeId}/photos/upload-url`)
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

  async function addPhoto(user: TestUser, placeId: string, kind: 'place' | 'menu' = 'place', body?: Buffer) {
    const key = await upload(user, placeId, body ?? (await picture(2400, 1200)));
    const res = await api().post(`/places/${placeId}/photos`).set(user.auth).send({ kind, key }).expect(201);
    return res.body;
  }

  it('re-encodes to at most 1600 px plus a thumbnail, strips metadata, and serves both', async () => {
    const alice = await signUp(app, 'alice');
    const placeId = await aPlace(alice);
    const original = await picture(2400, 1200);
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const key = await upload(alice, placeId, original);
    const photo = (await api().post(`/places/${placeId}/photos`).set(alice.auth).send({ kind: 'menu', key }).expect(201)).body;
    expect(photo).toMatchObject({ kind: 'menu', width: 1600, height: 800, user: { id: alice.id, username: 'alice' } });
    expect(photo.url).toBe(`${process.env.PUBLIC_BASE_URL}/photos/${placeId}/${photo.id}.jpg`);
    expect(photo.thumbnailUrl).toBe(`${process.env.PUBLIC_BASE_URL}/photos/${placeId}/${photo.id}-t.jpg`);

    const full = await api().get(`/photos/${placeId}/${photo.id}.jpg`).expect(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    expect(full.headers['cache-control']).toContain('immutable');
    const meta = await sharp(full.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1600, height: 800 });
    expect(meta.exif).toBeUndefined();

    const thumb = await sharp((await api().get(`/photos/${placeId}/${photo.id}-t.jpg`).expect(200)).body as Buffer).metadata();
    expect(thumb).toMatchObject({ width: 400, height: 400 });
    expect(thumb.exif).toBeUndefined();

    // the raw upload is gone and was never reachable
    expect(await app.get(StorageService).size(key)).toBeNull();
  });

  it('lists photos newest first, by kind, with paging', async () => {
    const alice = await signUp(app, 'alice');
    const placeId = await aPlace(alice);
    const a = await addPhoto(alice, placeId, 'place', await picture(300, 200));
    const b = await addPhoto(alice, placeId, 'menu', await picture(300, 200, 'png'));
    const c = await addPhoto(alice, placeId, 'place', await picture(200, 300));

    const all = await api().get(`/places/${placeId}/photos`).set(alice.auth).expect(200);
    expect(all.body.items.map((p: { id: string }) => p.id)).toEqual([c.id, b.id, a.id]);
    expect(all.body.nextCursor).toBeNull();

    const menus = await api().get(`/places/${placeId}/photos`).query({ kind: 'menu' }).set(alice.auth).expect(200);
    expect(menus.body.items.map((p: { id: string }) => p.id)).toEqual([b.id]);

    const page1 = await api().get(`/places/${placeId}/photos`).query({ limit: 2 }).set(alice.auth).expect(200);
    expect(page1.body.items).toHaveLength(2);
    const page2 = await api()
      .get(`/places/${placeId}/photos`)
      .query({ limit: 2, cursor: page1.body.nextCursor })
      .set(alice.auth)
      .expect(200);
    expect(page2.body.items.map((p: { id: string }) => p.id)).toEqual([a.id]);

    await api().get(`/places/${placeId}/photos`).query({ kind: 'selfie' }).set(alice.auth).expect(400);
    await api().get(`/places/00000000-0000-4000-8000-000000000000/photos`).set(alice.auth).expect(404);
  });

  it('hides photos across a block, and lets only the owner delete one', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    await befriend(app, alice, bob);
    const placeId = await aPlace(alice);
    const photo = await addPhoto(bob, placeId, 'place', await picture(300, 300));

    expect((await api().get(`/places/${placeId}/photos`).set(alice.auth).expect(200)).body.items).toHaveLength(1);
    await api().delete(`/places/${placeId}/photos/${photo.id}`).set(alice.auth).expect(404);

    await api().post('/blocks').set(alice.auth).send({ userId: bob.id }).expect(204);
    expect((await api().get(`/places/${placeId}/photos`).set(alice.auth).expect(200)).body.items).toHaveLength(0);
    expect((await api().get(`/places/${placeId}/photos`).set(bob.auth).expect(200)).body.items).toHaveLength(1);

    await api().delete(`/places/${placeId}/photos/${photo.id}`).set(bob.auth).expect(204);
    await api().get(`/photos/${placeId}/${photo.id}.jpg`).expect(404);
    await api().delete(`/places/${placeId}/photos/${photo.id}`).set(bob.auth).expect(404);
  });

  it('accepts reports about photos, but not about your own', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    const placeId = await aPlace(alice);
    const photo = await addPhoto(bob, placeId, 'place', await picture(300, 300));

    await api().post('/reports').set(alice.auth).send({ targetType: 'photo', targetId: photo.id, reason: 'inappropriate' }).expect(201);
    const own = await api().post('/reports').set(bob.auth).send({ targetType: 'photo', targetId: photo.id, reason: 'spam' }).expect(400);
    expect(own.body.error.code).toBe('invalid_target');
    await api()
      .post('/reports')
      .set(alice.auth)
      .send({ targetType: 'photo', targetId: '00000000-0000-4000-8000-000000000000', reason: 'spam' })
      .expect(404);
  });

  it('removes a deleted account’s photos and their files', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    const placeId = await aPlace(alice);
    const photo = await addPhoto(bob, placeId, 'place', await picture(300, 300));

    await api().delete('/me').set(bob.auth).expect(204);
    expect((await api().get(`/places/${placeId}/photos`).set(alice.auth).expect(200)).body.items).toHaveLength(0);
    await api().get(`/photos/${placeId}/${photo.id}.jpg`).expect(404);
    await api().get(`/photos/${placeId}/${photo.id}-t.jpg`).expect(404);
  });

  it('serves only processed photos: unknown files, bad ids and raw uploads are refused', async () => {
    const alice = await signUp(app, 'alice');
    const placeId = await aPlace(alice);
    const key = await upload(alice, placeId, await picture(200, 200));
    await api().get(`/${key}`).expect(404);
    await api().get(`/photos/${placeId}/00000000-0000-4000-8000-000000000000.jpg`).expect(404);
    await api().get(`/photos/${placeId}/..%2F..%2Fuploads%2Fx`).expect(404);
    const bad = await api().get(`/photos/not-a-uuid/00000000-0000-4000-8000-000000000000.jpg`).expect(400);
    expect(bad.body.error.code).toBe('invalid_id');
  });

  it('refuses things that are not pictures, other people’s uploads and bad requests', async () => {
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bobby');
    const placeId = await aPlace(alice);

    const notAnImage = await upload(alice, placeId, Buffer.from('definitely not a jpeg, just some text'));
    const bad = await api().post(`/places/${placeId}/photos`).set(alice.auth).send({ kind: 'place', key: notAnImage }).expect(422);
    expect(bad.body.error.code).toBe('invalid_image');

    const bobsKey = await upload(bob, placeId, await picture(100, 100));
    const stolen = await api().post(`/places/${placeId}/photos`).set(alice.auth).send({ kind: 'place', key: bobsKey }).expect(400);
    expect(stolen.body.error.code).toBe('invalid_key');

    await api().post(`/places/${placeId}/photos`).set(alice.auth).send({ kind: 'place', key: `uploads/${alice.id}/does-not-exist` }).expect(404);
    await api().post(`/places/${placeId}/photos`).set(alice.auth).send({ kind: 'selfie', key: bobsKey }).expect(400);

    const url = `/places/${placeId}/photos/upload-url`;
    await api().post(url).set(alice.auth).send({ contentType: 'image/gif', contentLength: 10 }).expect(400);
    await api().post(url).set(alice.auth).send({ contentType: 'image/jpeg', contentLength: 11 * 1024 * 1024 }).expect(400);
    await api().post(url).send({ contentType: 'image/jpeg', contentLength: 10 }).expect(401);
    await api()
      .post('/places/00000000-0000-4000-8000-000000000000/photos/upload-url')
      .set(alice.auth)
      .send({ contentType: 'image/jpeg', contentLength: 10 })
      .expect(404);
  });
});
