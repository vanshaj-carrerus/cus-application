import { getCurrentUser } from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Name</div>
            <div className="text-slate-900">{user.name}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Email</div>
            <div className="text-slate-900">{user.email}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Role</div>
            <div className="text-slate-900">{user.role.replace(/_/g, " ")}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-slate-500">
          Notification preferences (email digest frequency, in-app alert types) are configured by an admin under Admin → System settings.
        </CardContent>
      </Card>
    </div>
  );
}
