import { mkdir, readFile, writeFile, unlink, rm } from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2Client, getR2KeyFromPublicUrl, getR2PublicUrl, isR2Configured } from "@/lib/storage/r2";

/**
 * Two backends behind one interface:
 *  - Cloudflare R2 (`cloud: true`): used for generated resumes. The returned `url` is the
 *    bucket's public URL and is what gets stored on the Resume document, so it is
 *    directly linkable and readable from any server/worker.
 *  - Local disk (default): private directory outside the Next.js static root, served only
 *    through the authenticated /api/files/[...path] route. Still used for audit-proof
 *    screenshots.
 */

const STORAGE_ROOT = path.join(process.cwd(), "storage", "generated");

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
};

export interface StoredFile {
  key: string; // relative path / R2 object key
  url: string; // R2 public URL, or app-relative URL served by the authenticated /api/files route
}

export async function saveFile(
  buffer: Buffer,
  opts: { subdir: string; extension: string; cloud?: boolean }
): Promise<StoredFile> {
  const filename = `${randomUUID()}.${opts.extension}`;
  const key = `${opts.subdir}/${filename}`;

  if (opts.cloud) {
    if (!isR2Configured()) {
      throw new Error(
        "Cloudflare R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME and NEXT_PUBLIC_R2_PUBLIC_URL"
      );
    }
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: CONTENT_TYPES[opts.extension] ?? "application/octet-stream",
      })
    );
    return { key, url: getR2PublicUrl(key) };
  }

  const dir = path.join(STORAGE_ROOT, opts.subdir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), buffer);
  return { key, url: `/api/files/${key}` };
}

function localKey(urlOrKey: string): string {
  return urlOrKey.startsWith("/api/files/") ? urlOrKey.slice("/api/files/".length) : urlOrKey;
}

function resolveStoredPath(key: string): string {
  const resolved = path.resolve(STORAGE_ROOT, key);
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT))) {
    throw new Error("Invalid file key");
  }
  return resolved;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  return readFile(resolveStoredPath(key));
}

/** Best-effort delete — a missing file (already gone, or never ours) is not an error here. */
export async function deleteStoredFile(urlOrKey: string): Promise<void> {
  const r2Key = getR2KeyFromPublicUrl(urlOrKey);
  if (r2Key) {
    try {
      await getR2Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }));
    } catch {
      // ignore — this shouldn't block the DB delete
    }
    return;
  }

  try {
    await unlink(resolveStoredPath(localKey(urlOrKey)));
  } catch {
    // ignore — nothing more we can do, and this shouldn't block the DB delete
  }
}

/**
 * Gives a stored file a real path on disk, e.g. to hand to Playwright's setInputFiles().
 * Local files are returned in place; R2 files are downloaded to a temp file. Always call
 * cleanup() when done (it's a no-op for local files).
 */
export async function materializeStoredFile(urlOrKey: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const r2Key = getR2KeyFromPublicUrl(urlOrKey);
  if (!r2Key) {
    return { path: resolveStoredPath(localKey(urlOrKey)), cleanup: async () => {} };
  }

  const res = await getR2Client().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }));
  if (!res.Body) throw new Error(`R2 object ${r2Key} has no body`);
  const bytes = await res.Body.transformToByteArray();

  const dir = path.join(os.tmpdir(), "cus-resumes", randomUUID());
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, path.basename(r2Key));
  await writeFile(filePath, bytes);

  return { path: filePath, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}
