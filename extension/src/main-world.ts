/**
 * Runs inside Glassdoor's own page (not in the extension's isolated world) so it can see what the page's scripts do.
 * Glassdoor's Apply button opens the employer's site with window.open. The browser blocks that when the click does not
 * come from a person, so while a CUS Assist run asks for it, window.open is caught here: the address goes to the
 * extension, which opens it itself. Outside of that request window.open behaves exactly as normal.
 */
(() => {
  const original = window.open.bind(window);
  let capturing = false;

  window.addEventListener("message", (event) => {
    const data = event.data as { source?: string; type?: string; on?: boolean } | null;
    if (event.source === window && data?.source === "cus-assist-isolated" && data.type === "capture") capturing = !!data.on;
  });

  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (!capturing) return original(url, target, features);
    try {
      if (url) window.postMessage({ source: "cus-assist-main", type: "open", url: new URL(String(url), location.href).href }, location.origin);
    } catch {
      /* an address that cannot be read is simply not captured */
    }
    return null;
  }) as typeof window.open;
})();
