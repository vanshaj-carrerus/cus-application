/**
 * Platform-specific knowledge that is cheaper to apply on the server before the browser opens: a Lever posting's
 * form lives at <posting>/apply; opening it directly skips the posting page and its overlays. Everything else (field
 * selectors, confirmation pages) lives in the extension's form engine (formEngine.ts).
 */
export function directApplicationUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)lever\.co$/i.test(u.hostname)) return url;
    const parts = u.pathname.split("/").filter(Boolean);
    // /<company>/<posting-id>  ->  /<company>/<posting-id>/apply
    if (parts.length === 2 && /^[0-9a-f-]{20,}$/i.test(parts[1])) {
      u.pathname = `/${parts.join("/")}/apply`;
      return u.toString();
    }
  } catch {
    /* not a URL */
  }
  return url;
}
