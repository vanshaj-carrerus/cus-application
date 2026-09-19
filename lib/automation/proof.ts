import type { Page } from "playwright";
import { saveFile, type StoredFile } from "@/lib/storage/fileStorage";

export interface CapturedProof extends StoredFile {
  buffer: Buffer;
}

/** Full-page screenshot as audit proof of a submission attempt (success or failure). */
export async function captureProof(page: Page, subdir: string): Promise<CapturedProof> {
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  const stored = await saveFile(buffer, { subdir, extension: "png" });
  return { ...stored, buffer };
}
