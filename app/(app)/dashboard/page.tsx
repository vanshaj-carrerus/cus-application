import { getCurrentUser } from "@/lib/auth/current-user";
import { getCommandCenter } from "@/lib/services/dashboardService";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { Sparkles, TrendingUp, Users, Briefcase, CalendarClock, AlertTriangle } from "lucide-react";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const data = await getCommandCenter(user.sub, user.role);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">
          {greeting()}, {user.name.split(" ")[0]}.
        </h1>
        <p className="mt-1 text-sm text-slate-500">Here&apos;s what needs your attention.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile icon={Sparkles} label="High matches" value={data.stats.highMatchCandidates} />
        <StatTile icon={TrendingUp} label="Strong job matches" value={data.stats.strongJobMatchCount} />
        <StatTile icon={Briefcase} label="Need action" value={data.stats.applicationsNeedingAction} />
        <StatTile icon={CalendarClock} label="Interviews today" value={data.stats.interviewsToday} />
        <StatTile icon={Users} label="Not contacted" value={data.stats.uncontactedCandidates} />
        <StatTile icon={AlertTriangle} label="Difficult jobs" value={data.stats.difficultJobs} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AI Insights</CardTitle>
        </CardHeader>
        <CardContent>
          {data.insights.length === 0 ? (
            <p className="text-sm text-slate-500">
              No standout signals yet — sync jobs and add candidates to start generating insights.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.insights.map((insight, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-900" />
                  {insight}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Priorities</CardTitle>
        </CardHeader>
        <CardContent>
          {data.priorities.length === 0 ? (
            <p className="text-sm text-slate-500">No high-priority items right now. Run matching to generate priorities.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.priorities.map((p) => (
                <Link
                  key={p.id}
                  href={p.entityId ? `/candidates/${p.entityId}` : "#"}
                  className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 hover:bg-slate-50 -mx-2 px-2 rounded-md"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={p.level === "HIGH" ? "success" : "info"}>{p.level}</Badge>
                    <span className="text-sm font-medium text-slate-900">{p.title}</span>
                  </div>
                  <p className="text-xs text-slate-500">{p.detail}</p>
                  <p className="text-xs text-slate-500 italic">&ldquo;{p.why}&rdquo;</p>
                  <p className="text-xs font-medium text-slate-700">→ {p.action}</p>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <Icon className="h-4 w-4 text-slate-400" />
        <div className="text-xl font-semibold text-slate-900">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </CardContent>
    </Card>
  );
}
