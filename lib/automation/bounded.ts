/**
 * Runs `work` but gives up after `ms` and returns `fallback` instead. A browser call on a page that is stuck
 * mid-navigation (most often through a remote browser) can wait forever — Playwright's `locator.count()` and
 * `page.evaluate()` have no timeout of their own — and one such call would freeze the whole apply run. Detection
 * code that can safely answer "don't know" uses this so a stuck page costs seconds, not the run.
 */
export async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, gaveUp]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined); // a late failure of abandoned work must not surface as an unhandled rejection
  }
}
