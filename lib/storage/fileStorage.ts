import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

/**
 * Generated resumes/cover letters contain candidate PII, so they are never written
 * under /public (world-readable by URL guessing). They live in a private directory
 * outside the Next.js static root and are only ever served through the authenticated
 * /api/files/[...path] route. Swap this module for an S3-backed implementation later
 * without touching callers — they only depend on saveFile()/readStoredFile().
 */

const STORAGE_ROOT = path.join(process.cwd(), "storage", "generated");

export interface StoredFile {
  key: string; // relative path, used as the id passed to /api/files
  url: string; // app-relative URL to fetch it through the authenticated route
}

export async function saveFile(buffer: Buffer, opts: { subdir: string; extension: string }): Promise<StoredFile> {
  const dir = path.join(STORAGE_ROOT, opts.subdir);
  await mkdir(dir, { recursive: true });

  const filename = `${randomUUID()}.${opts.extension}`;
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, buffer);

  const key = `${opts.subdir}/${filename}`;
  return { key, url: `/api/files/${key}` };
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

/** Best-effort delete — a missing file (already gone, or never a local key) is not an error here. */
export async function deleteStoredFile(urlOrKey: string): Promise<void> {
  const key = urlOrKey.startsWith("/api/files/") ? urlOrKey.slice("/api/files/".length) : urlOrKey;
  try {
    await unlink(resolveStoredPath(key));
  } catch {
    // ignore — nothing more we can do, and this shouldn't block the DB delete
  }
}

/** Absolute filesystem path for a stored file, e.g. to hand to Playwright's setInputFiles(). */
export function storedFilePath(urlOrKey: string): string {
  const key = urlOrKey.startsWith("/api/files/") ? urlOrKey.slice("/api/files/".length) : urlOrKey;
  return resolveStoredPath(key);
}
