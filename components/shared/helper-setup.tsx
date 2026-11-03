"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Talking to the CUS Assist browser extension. The extension's content script runs on every page and answers
 * window messages from the portal, so there is no native app, no terminal and no link handler to install.
 */

function ask<T extends { type: string }>(message: Record<string, unknown>, replyType: string, timeoutMs: number, match?: (m: T) => boolean): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeoutMs);
    function onMessage(event: MessageEvent) {
      const data = event.data as T & { source?: string };
      if (event.source !== window || data?.source !== "cus-assist" || data.type !== replyType || (match && !match(data))) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "cus-portal", ...message }, window.location.origin);
  });
}

/** Is the extension installed in this browser, and connected to this portal? */
export async function pingExtension(): Promise<{ installed: boolean; paired: boolean }> {
  const reply = await ask<{ type: string; paired?: boolean }>({ type: "PING" }, "PONG", 1_200);
  return { installed: !!reply, paired: !!reply?.paired };
}

/** Asks the extension to open an application (it must already be marked APPLY_REQUESTED on the server). */
export async function requestApply(applicationId: string): Promise<{ ok: boolean; error?: string }> {
  const reply = await ask<{ type: string; applicationId?: string; ok?: boolean; error?: string }>({ type: "APPLY", applicationId }, "APPLY_RESULT", 30_000, (m) => m.applicationId === applicationId);
  if (!reply) return { ok: false, error: "The extension didn't respond. Is it installed in this browser, and is the page reloaded since installing it?" };
  return { ok: !!reply.ok, error: reply.error };
}

/** One-time setup: install the extension, then connect it to this person's login. */
export function HelperSetup({ onStatus }: { onStatus?: (s: { installed: boolean; paired: boolean }) => void }) {
  const [state, setState] = useState<{ installed: boolean; paired: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const check = useCallback(async () => {
    const s = await pingExtension();
    setState(s);
    onStatus?.(s);
    return s;
  }, [onStatus]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- check once on load; keep checking while the steps are showing
    check().then((s) => setOpen(!s.paired));
  }, [check]);

  useEffect(() => {
    if (!open || state?.paired) return;
    const timer = setInterval(check, 3_000);
    return () => clearInterval(timer);
  }, [open, state?.paired, check]);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/helper/pair", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data.token) {
        setMessage("Could not create a connection. Please try again.");
        return;
      }
      const reply = await ask<{ type: string; ok?: boolean }>({ type: "PAIR", token: data.token }, "PAIRED", 120_000);
      setMessage(reply?.ok ? null : "Not connected. Click OK in the extension's confirmation box.");
      await check();
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;
  const { installed, paired } = state;

  return (
    <Card id="helper-setup">
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-slate-900">
            Apply extension{" "}
            {paired ? (
              <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-normal text-emerald-700">connected</span>
            ) : (
              <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-700">{installed ? "installed, not connected" : "set up once in this browser"}</span>
            )}
          </div>
          <button className="text-xs text-slate-500 underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : paired ? "Reconnect or reinstall" : "Show steps"}
          </button>
        </div>
        {open && (
          <ol className="flex flex-col gap-2 text-sm text-slate-700">
            <li className="flex flex-wrap items-center gap-2">
              <b>1.</b> Download the extension:
              <Button asChild size="sm" variant="secondary">
                <a href="/api/helper/download">Download extension</a>
              </Button>
              {installed && <span className="text-xs text-emerald-700">found in this browser</span>}
            </li>
            <li>
              <b>2.</b> Unzip it. In Edge or Chrome open <code className="rounded bg-slate-100 px-1">edge://extensions</code> (or <code className="rounded bg-slate-100 px-1">chrome://extensions</code>), turn on <b>Developer mode</b>,
              click <b>Load unpacked</b> and pick the unzipped folder. Then reload this page.
            </li>
            <li className="flex flex-wrap items-center gap-2">
              <b>3.</b> Click:
              <Button size="sm" disabled={busy || !installed} onClick={connect}>
                Connect extension
              </Button>
              {!installed && <span className="text-xs text-slate-500">available once the extension is installed</span>}
              {message && <span className="text-xs text-red-600">{message}</span>}
            </li>
            <li className="text-xs text-slate-500">After that, the Apply button opens the job in a new tab of your own browser with the form assistant running. Your normal browser, your normal sign-ins.</li>
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
