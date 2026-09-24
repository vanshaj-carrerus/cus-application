import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { Topbar } from "@/components/layout/topbar";
import Link from "next/link";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "CANDIDATE") redirect("/dashboard");

  return (
    <div className="flex min-h-screen w-full flex-col">
      <Topbar name={user.name} role={user.role} />
      <div className="border-b border-slate-200 bg-white px-4 md:px-6">
        <nav className="flex gap-4 text-sm font-medium text-slate-600">
          <Link href="/portal" className="py-3 hover:text-slate-900">
            Overview
          </Link>
          <Link href="/portal/applications" className="py-3 hover:text-slate-900">
            My Applications
          </Link>
          <Link href="/portal/profile" className="py-3 hover:text-slate-900">
            My Profile
          </Link>
          <Link href="/portal/credentials" className="py-3 hover:text-slate-900">
            Job Board Logins
          </Link>
          <Link href="/portal/gmail" className="py-3 hover:text-slate-900">
            Email Access
          </Link>
        </nav>
      </div>
      <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
    </div>
  );
}
