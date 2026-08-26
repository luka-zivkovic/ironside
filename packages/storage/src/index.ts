import { createReadStream } from "node:fs";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export class InvalidJsonObjectError extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(`object ${key} does not contain valid JSON`, { cause });
    this.name = "InvalidJsonObjectError";
    this.key = key;
  }
}

export class ObjectTooLargeError extends Error {
  readonly key: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(key: string, sizeBytes: number, maxBytes: number) {
    super(`object ${key} is ${sizeBytes} bytes, exceeding the ${maxBytes}-byte limit`);
    this.name = "ObjectTooLargeError";
    this.key = key;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

export function isObjectNotFoundError(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.Code === "NoSuchKey"
  );
}

export interface ObjectStorage {
  /** Creates the bucket if it does not exist yet (idempotent). */
  ensureBucket(): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson(key: string, options?: { maxBytes?: number }): Promise<unknown>;
  /** Stores raw bytes with an explicit content type (media assets). */
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Fetches raw bytes plus the stored content type. */
  getBytes(key: string): Promise<{ body: Uint8Array; contentType?: string }>;
  /** Streams a local file to the destination bucket — multipart upload via @aws-sdk/lib-storage, so export files of unbounded size don't need to be buffered in memory. */
  putFile(key: string, localFilePath: string, contentType: string): Promise<void>;
  /** Idempotently deletes one object. S3 treats a missing key as success. */
  delete(key: string): Promise<void>;
  /** Checks one key without downloading its body. */
  exists(key: string): Promise<boolean>;
  /** Returns exact object metadata without downloading its body, or null when absent. */
  stat(key: string): Promise<StoredObject | null>;
  /**
   * Lazily yields every object key under `prefix`, following ListObjectsV2
   * pagination. Async-iterable rather than an array so callers can stop
   * early (e.g. a capped scan) without listing the whole prefix.
   */
  list(prefix: string, options?: { startAfter?: string }): AsyncIterable<string>;
  /**
   * Lazily yields object metadata without downloading bodies. This is the
   * read-only inventory primitive used by lifecycle planning; `list()` stays
   * as the lightweight key-only compatibility surface.
   */
  listObjects(
    prefix: string,
    options?: { startAfter?: string }
  ): AsyncIterable<StoredObject>;
  healthCheck(): Promise<void>;
  close(): void;
}

export interface StoredObject {
  key: string;
  sizeBytes: number;
  lastModified?: Date;
}

export function createObjectStorage(config: StorageConfig): ObjectStorage {
  // forcePathStyle is required for MinIO and harmless for AWS S3.
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: true
  });

  async function* listObjects(
    prefix: string,
    options?: { startAfter?: string }
  ): AsyncIterable<StoredObject> {
    let continuationToken: string | undefined;
    do {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ...(options?.startAfter && !continuationToken && { StartAfter: options.startAfter }),
          ...(continuationToken && { ContinuationToken: continuationToken })
        })
      );
      for (const object of result.Contents ?? []) {
        if (object.Key !== undefined) {
          yield {
            key: object.Key,
            sizeBytes: object.Size ?? 0,
            ...(object.LastModified && { lastModified: object.LastModified })
          };
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return;
      } catch {
        // HEAD failed — fall through to create. This is racy by design:
        // api and worker both call ensureBucket() independently at boot
        // (docker-compose brings them up concurrently), so both can HEAD
        // the bucket before either has created it, and both then attempt
        // CREATE. Only one CreateBucketCommand actually wins; the loser
        // gets BucketAlreadyOwnedByYou (S3-compatible semantics for the
        // SAME account re-creating its own bucket — not a real error,
        // just confirmation the bucket exists). Treating that as success
        // is what makes ensureBucket() genuinely idempotent under this
        // concurrent-caller race, not just when called from one process.
      }
      try {
        await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        const code = (error as { Code?: string; name?: string }).Code ?? (error as { name?: string }).name;
        if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
          return;
        }
        throw error;
      }
    },

    async putJson(key, value) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: JSON.stringify(value),
          ContentType: "application/json"
        })
      );
    },

    async getJson(key, options) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key })
      );
      if (
        options?.maxBytes !== undefined &&
        result.ContentLength !== undefined &&
        result.ContentLength > options.maxBytes
      ) {
        // Do not transform/buffer an oversized response body. Destroying the
        // stream also releases the underlying HTTP connection promptly.
        (result.Body as { destroy?: () => void } | undefined)?.destroy?.();
        throw new ObjectTooLargeError(key, result.ContentLength, options.maxBytes);
      }
      const text = await result.Body?.transformToString();
      if (text === undefined) {
        throw new Error(`object ${key} has no body`);
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        if (error instanceof SyntaxError) throw new InvalidJsonObjectError(key, error);
        throw error;
      }
    },

    async putBytes(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType
        })
      );
    },

    async getBytes(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key })
      );
      const bytes = await result.Body?.transformToByteArray();
      if (bytes === undefined) {
        throw new Error(`object ${key} has no body`);
      }
      return { body: bytes, ...(result.ContentType && { contentType: result.ContentType }) };
    },

    async putFile(key, localFilePath, contentType) {
      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: createReadStream(localFilePath),
          ContentType: contentType
        }
      });
      await upload.done();
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
      } catch (error) {
        if (isObjectNotFoundError(error)) return false;
        throw error;
      }
    },

    async stat(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key })
        );
        return {
          key,
          sizeBytes: result.ContentLength ?? 0,
          ...(result.LastModified && { lastModified: result.LastModified })
        };
      } catch (error) {
        if (isObjectNotFoundError(error)) return null;
        throw error;
      }
    },

    async *list(prefix, options) {
      for await (const object of listObjects(prefix, options)) {
        yield object.key;
      }
    },

    listObjects,

    async healthCheck() {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    },

    close() {
      client.destroy();
    }
  };
}
