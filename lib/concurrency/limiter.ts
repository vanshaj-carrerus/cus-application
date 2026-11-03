/**
 * Process-wide concurrency limits. Everything heavy the server does (AI calls, PDF rendering, resume tailoring) goes
 * through one of these, so a hundred people clicking at once queue up behind a fixed number of workers instead of
 * opening a hundred browsers and a hundred AI requests at the same moment.
 *
 * Limits live in this server process. Running several server instances multiplies them by the instance count.
 */

export interface Limiter {
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Jobs currently running / waiting, for logs and health checks. */
  stats(): { active: number; waiting: number; max: number };
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await work();
      } finally {
        release();
      }
    },
    stats: () => ({ active, waiting: waiting.length, max }),
  };
}

const g = globalThis as unknown as { __limiters?: Map<string, Limiter> };

/** One shared limiter per name, surviving hot reloads in development. */
export function sharedLimiter(name: string, envVar: string, fallback: number): Limiter {
  const map = (g.__limiters ??= new Map());
  let limiter = map.get(name);
  if (!limiter) {
    limiter = createLimiter(Math.max(1, Number(process.env[envVar]) || fallback));
    map.set(name, limiter);
  }
  return limiter;
}

/** AI provider calls (resume tailoring, cover letters, form answers). */
export const aiLimiter = () => sharedLimiter("ai", "AI_CONCURRENCY", 8);
/** Resume PDF renders. */
export const pdfLimiter = () => sharedLimiter("pdf", "PDF_CONCURRENCY", 3);
/** Whole "prepare this application" runs (AI + PDF + saving), across every request in this process. */
export const tailorLimiter = () => sharedLimiter("tailor", "TAILOR_GLOBAL_CONCURRENCY", 6);
