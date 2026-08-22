// S3-compatible adapter (7e) — a signed-URL redirect, no duplication, works with real AWS
// S3 or a self-hosted compatible target (MinIO etc, via LIFER_S3_ENDPOINT). One shared
// bucket config via env vars, not a per-user settings table — this is a personal/small-group
// deployment with no real multi-target use case yet, so that would be premature.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PhotoSource, PhotoSourceAsset } from "@lifer/shared";
import { pool } from "../db.js";

const S3_ENDPOINT = process.env.LIFER_S3_ENDPOINT; // unset = real AWS S3
const S3_BUCKET = process.env.LIFER_S3_BUCKET;
const S3_REGION = process.env.LIFER_S3_REGION ?? "us-east-1";

export function s3Configured(): boolean {
  return !!S3_BUCKET;
}

function client(): S3Client {
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: !!S3_ENDPOINT, // required by most self-hosted S3-compatibles (MinIO etc.)
  });
}

export async function fetchS3Object(key: string): Promise<Buffer> {
  if (!S3_BUCKET) throw new Error("LIFER_S3_BUCKET is not configured");
  const res = await client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function signedS3Url(key: string): Promise<string> {
  if (!S3_BUCKET) throw new Error("LIFER_S3_BUCKET is not configured");
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: 3600 });
}

export class S3PhotoSource implements PhotoSource {
  async listPhotos(): Promise<PhotoSourceAsset[]> {
    // No bucket-browsing UI — objects are linked one at a time by key via the upload flow's
    // mode=s3, not discovered by enumerating a bucket, so there's nothing to list here.
    return [];
  }

  async originalUrl(captureId: string): Promise<string | null> {
    if (!S3_BUCKET) return null;
    const res = await pool.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1 AND ref_type = 's3'`, [
      captureId,
    ]);
    const key = res.rows[0]?.ref;
    return key ? signedS3Url(key) : null;
  }
}
