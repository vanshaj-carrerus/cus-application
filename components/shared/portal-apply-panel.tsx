"use client";

import { useCallback, useEffect, useState } from "react";
import { PortalApplyCard, type ApplyRunView } from "@/components/shared/portal-apply";

/** The Start card for a portal that only auto-applies (no profile data to read), with its own live status. */
export function PortalApplyPanel({ portal, name, candidateId, extReady }: { portal: string; name: string; candidateId?: string; extReady: boolean }) {
  const [apply, setApply] = useState<ApplyRunView | null>(null);
  const query = `?portal=${portal}${candidateId ? `&candidateId=${candidateId}` : ""}`;

  const load = useCallback(async () => {
    const res = await fetch(`/api/portals/snapshots${query}`);
    if (res.ok) setApply((await res.json()).apply ?? null);
  }, [query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const active = apply?.state === "RUNNING" || apply?.state === "PAUSED" || apply?.state === "STOPPING";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 3_000);
    return () => clearInterval(timer);
  }, [active, load]);

  return <PortalApplyCard portal={portal} name={name} candidateId={candidateId} apply={apply} extReady={extReady} reload={load} />;
}
