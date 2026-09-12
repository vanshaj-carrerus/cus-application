import type { Page } from "playwright";
import { saveFile, type StoredFile } from "@/lib/storage/fileStorage";

/** Full-page screenshot as audit proof of a submission attempt (success or failure). */
export async function captureProof(page: Page, subdir: string): Promise<StoredFile> {
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  return saveFile(buffer, { subdir, extension: "png" });
}
