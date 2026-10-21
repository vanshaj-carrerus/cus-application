/**
 * Gives every outbound `fetch` in this process a time limit unless the caller set its own. Node's fetch
 * waits forever by default, so one AI provider that accepts a connection and then goes quiet would hold an
 * apply run (and its browser, and its worker slot) hostage for good. Installing this once at start-up covers
 * every adapter and SDK that uses the global fetch, including ones added later.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 60_000;

let installed = false;

export function installDefaultFetchTimeout(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) return original(input, init); // the caller chose its own limit
    return original(input, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  }) as typeof fetch;
}
