import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Env } from "@soa/shared";

/* File storage (ARCHITECTURE.md §2): S3 in AWS, MinIO locally, an in-memory fake in tests. */

export interface ObjectStore {
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  get: (key: string) => Promise<Buffer>;
  delete: (key: string) => Promise<void>;
}

export function createS3ObjectStore(config: Pick<Env, "S3_BUCKET" | "S3_ENDPOINT" | "AWS_REGION">): ObjectStore {
  const local = config.S3_ENDPOINT !== undefined;
  const client = new S3Client({
    region: config.AWS_REGION,
    ...(local
      ? {
          endpoint: config.S3_ENDPOINT,
          forcePathStyle: true,
          // Local MinIO only (docker-compose.yml). In AWS the task role supplies credentials.
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
          },
        }
      : {}),
  });
  const bucket = config.S3_BUCKET;
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // No header in AWS: the bucket's default (KMS) encryption applies.
        }),
      );
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (result.Body === undefined) throw new Error("empty object");
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function createMemoryObjectStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put(key, body) {
      objects.set(key, Buffer.from(body));
      return Promise.resolve();
    },
    get(key) {
      const body = objects.get(key);
      return body === undefined ? Promise.reject(new Error("no such object")) : Promise.resolve(body);
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
