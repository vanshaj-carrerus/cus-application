import { chromium } from "playwright";
import { saveFile, type StoredFile } from "@/lib/storage/fileStorage";

/** Renders an HTML string to a PDF buffer via headless Chromium. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const buffer = await page.pdf({
      format: "A4",
      margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
      printBackground: true,
    });
    return buffer;
  } finally {
    await browser.close();
  }
}

export async function renderAndStorePdf(html: string, subdir: string): Promise<StoredFile> {
  const buffer = await renderHtmlToPdf(html);
  return saveFile(buffer, { subdir, extension: "pdf" });
}
