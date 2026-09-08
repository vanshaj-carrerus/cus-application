import type { Role } from "@/lib/models/enums";

export interface NavItem {
  href: string;
  label: string;
  icon: string; // lucide icon name, resolved in sidebar.tsx
  roles?: Role[]; // omit = all roles
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Command Center", icon: "LayoutDashboard" },
  { href: "/jobs", label: "Jobs", icon: "Briefcase" },
  { href: "/candidates", label: "Candidates", icon: "Users" },
  { href: "/matching", label: "Matching", icon: "Sparkles" },
  { href: "/applications", label: "Applications", icon: "FileText" },
  { href: "/resumes", label: "Resumes", icon: "FileStack" },
  { href: "/ai-copilot", label: "AI Copilot", icon: "Bot" },
  { href: "/analytics", label: "Analytics", icon: "BarChart3" },
  { href: "/recruiters", label: "Recruiters", icon: "UserCog", roles: ["SUPER_ADMIN", "ADMIN"] },
  { href: "/clients", label: "Clients", icon: "Building2" },
  { href: "/notifications", label: "Notifications", icon: "Bell" },
  { href: "/admin", label: "Admin", icon: "ShieldCheck", roles: ["SUPER_ADMIN", "ADMIN"] },
  { href: "/settings", label: "Settings", icon: "Settings" },
];
