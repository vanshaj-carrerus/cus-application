"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface ClientRow {
  _id: string;
  name: string;
  status: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/clients")
      .then((r) => r.json())
      .then((d) => setClients(d.clients ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">Clients</h1>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : clients.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-500">No clients yet.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-2">
          {clients.map((c) => (
            <Card key={c._id}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-sm font-medium text-slate-900">{c.name}</div>
                  <div className="text-xs text-slate-500">{c.primaryContactName}</div>
                </div>
                <Badge variant={c.status === "ACTIVE" ? "success" : "secondary"}>{c.status}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
