"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Topbar({ name, role }: { name: string; role: string }) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 md:px-6">
      <div className="text-sm text-slate-500">AI Recruitment Operating System</div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-sm font-medium leading-tight">{name}</div>
          <div className="text-xs leading-tight text-slate-400">{role.replace(/_/g, " ")}</div>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
          {name.slice(0, 2).toUpperCase()}
        </div>
        <Button variant="ghost" size="icon" onClick={handleLogout} title="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
