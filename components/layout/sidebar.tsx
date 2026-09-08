"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Briefcase,
  Users,
  Sparkles,
  FileText,
  FileStack,
  Bot,
  BarChart3,
  UserCog,
  Building2,
  Bell,
  ShieldCheck,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { NAV_ITEMS } from "./nav-items";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/models/enums";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Briefcase,
  Users,
  Sparkles,
  FileText,
  FileStack,
  Bot,
  BarChart3,
  UserCog,
  Building2,
  Bell,
  ShieldCheck,
  Settings,
};

export function Sidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role));

  return (
    <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-white">
          <Sparkles className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold">RecruitAI</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
