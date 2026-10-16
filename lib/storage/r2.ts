import { S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 (S3-compatible) client — same env vars as the CUS-Recruit app's
 * tenant-logos uploads: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET_NAME and NEXT_PUBLIC_R2_PUBLIC_URL (the bucket's public/custom domain).
 *
 * The client is created lazily: the standalone worker process loads .env at runtime,
 * so reading process.env at import time could see it empty.
 */

let client: S3Client | null = null;

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME &&
      process.env.NEXT_PUBLIC_R2_PUBLIC_URL
  );
}

export function getR2Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

function publicBase(): string {
  return (process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? "").replace(/\/$/, "");
}

export function getR2PublicUrl(fileKey: string): string {
  return `${publicBase()}/${fileKey}`;
}

/** Returns the object key if `url` points into our R2 bucket, otherwise null. */
export function getR2KeyFromPublicUrl(url: string): string | null {
  const base = publicBase();
  if (!base || !url.startsWith(`${base}/`)) return null;
  return url.slice(base.length + 1);
}
