"use client";

import { PortalsPanel } from "@/components/shared/portals-panel";

export default function CandidatePortalsPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">My Portals</h1>
        <p className="text-sm text-slate-500">Connect your job-portal accounts so we can work with your profiles and applications.</p>
      </div>
      <PortalsPanel />
    </div>
  );
}
