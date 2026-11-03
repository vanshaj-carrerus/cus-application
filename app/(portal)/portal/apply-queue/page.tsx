"use client";

import { useEffect, useState } from "react";
import { ApplyQueueView } from "@/components/shared/apply-queue-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function PortalApplyQueuePage() {
  const [candidateId, setCandidateId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/portal/me")
      .then((r) => r.json())
      .then((d) => setCandidateId(d.candidate?._id ?? null));
  }, []);

  if (!candidateId) return <Skeleton className="h-64 w-full max-w-5xl" />;
  return <ApplyQueueView fixedCandidateId={candidateId} />;
}
