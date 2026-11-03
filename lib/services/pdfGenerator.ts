import { chromium, type Browser } from "playwright";
import { saveFile, type StoredFile } from "@/lib/storage/fileStorage";
import { pdfLimiter } from "@/lib/concurrency/limiter";

// One long-lived Chromium for the whole server, with a fresh page per render. Launching a browser per resume (what
// this used to do) costs ~1s and ~150MB each, which collapses under a crowd.
const g = globalThis as unknown as { __pdfBrowser?: Promise<Browser> };

function sharedBrowser(): Promise<Browser> {
  const existing = g.__pdfBrowser;
  if (existing) return existing;
  const launched = chromium.launch().then((browser) => {
    browser.on("disconnected", () => {
      if (g.__pdfBrowser === launched) g.__pdfBrowser = undefined; // crashed or closed: launch a new one next time
    });
    return browser;
  });
  launched.catch(() => {
    if (g.__pdfBrowser === launched) g.__pdfBrowser = undefined;
  });
  g.__pdfBrowser = launched;
  return launched;
}

/** Renders an HTML string to a PDF buffer via headless Chromium (at most PDF_CONCURRENCY at a time). */
export function renderHtmlToPdf(html: string): Promise<Buffer> {
  return pdfLimiter().run(async () => {
    const browser = await sharedBrowser();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      return await page.pdf({
        format: "A4",
        margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
        printBackground: true,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

/** Renders and uploads the PDF to Cloudflare R2; the returned url is the public R2 URL. */
export async function renderAndStorePdf(html: string, subdir: string): Promise<StoredFile> {
  const buffer = await renderHtmlToPdf(html);
  return saveFile(buffer, { subdir, extension: "pdf", cloud: true });
}
