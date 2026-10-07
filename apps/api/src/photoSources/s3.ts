// S3-compatible originals (AWS or MinIO via LIFER_S3_ENDPOINT), served as signed-URL redirects.
// One bucket for the whole server, configured by env vars.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PhotoSource, PhotoSourceAsset } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { contentDisposition } from "../lib/httpFile.js";

const S3_ENDPOINT = process.env.LIFER_S3_ENDPOINT; // unset = real AWS S3
const S3_BUCKET = process.env.LIFER_S3_BUCKET;
const S3_REGION = process.env.LIFER_S3_REGION ?? "us-east-1";

export function s3Configured(): boolean {
  return !!S3_BUCKET;
}

// One client for the process: each S3Client holds its own connection pool and credential cache.
let cachedClient: S3Client | null = null;
function client(): S3Client {
  cachedClient ??= new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    forcePathStyle: !!S3_ENDPOINT, // required by most self-hosted S3-compatibles (MinIO etc.)
  });
  return cachedClient;
}

export async function fetchS3Object(key: string): Promise<Buffer> {
  if (!S3_BUCKET) throw new Error("LIFER_S3_BUCKET is not configured");
  const res = await client().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// downloadFilename goes into the signed URL's ResponseContentDisposition, since S3 serves the
// redirect target directly and only it can set the download header.
export async function signedS3Url(key: string, downloadFilename?: string): Promise<string> {
  if (!S3_BUCKET) throw new Error("LIFER_S3_BUCKET is not configured");
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ...(downloadFilename ? { ResponseContentDisposition: contentDisposition(downloadFilename) } : {}),
    }),
    { expiresIn: 3600 },
  );
}

export class S3PhotoSource implements PhotoSource {
  async listPhotos(): Promise<PhotoSourceAsset[]> {
    // Required by PhotoSource; S3 objects are linked one at a time by key, never listed.
    return [];
  }

  async originalUrl(captureId: string): Promise<string | null> {
    if (!S3_BUCKET) return null;
    const res = await pool.query<{ ref: string }>(
      `SELECT ref FROM originals WHERE capture_id = $1 AND ref_type = 's3'`,
      [captureId],
    );
    const key = res.rows[0]?.ref;
    return key ? signedS3Url(key) : null;
  }
}
