import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Thin wrapper over an S3-compatible bucket (AWS S3, Cloudflare R2, Railway buckets, a local S3 mock...). */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.bucket = config.s3.bucket;
    this.s3 = new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
      // Newer SDK versions add CRC32 checksum headers to uploads by default. Presigned URLs
      // then require the client to send a checksum it cannot know, and many S3-compatible
      // stores reject the request. Only compute checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /** Development convenience (S3_AUTO_CREATE_BUCKET, never in production): creates the bucket when it is missing. */
  async onModuleInit() {
    if (!this.config.s3.autoCreateBucket) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      this.logger.log(`Creating bucket ${this.bucket}`);
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** A URL the app can PUT the file to, valid for `expiresInSec`. The size and type are part of the signature. */
  presignPut(key: string, contentType: string, contentLength: number, expiresInSec = 300): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: expiresInSec },
    );
  }

  /** Size in bytes, or null when the object does not exist. */
  async size(key: string): Promise<number | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return head.ContentLength ?? 0;
    } catch (err) {
      if ((err as any)?.$metadata?.httpStatusCode === 404 || (err as any)?.name === 'NotFound') {
        return null;
      }
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  /** Like `get`, but null when the object does not exist. */
  async getIfExists(key: string): Promise<Buffer | null> {
    try {
      return await this.get(key);
    } catch (err) {
      if ((err as any)?.name === 'NoSuchKey' || (err as any)?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  /** Best effort: a leftover object is not worth failing a request over. */
  async delete(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.logger.warn(`Could not delete ${key}: ${(err as Error).message}`);
    }
  }
}
