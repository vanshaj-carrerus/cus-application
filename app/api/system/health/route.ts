import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { SyncLog } from "@/lib/models/SyncLog";
import { AiAnalysis } from "@/lib/models/AiAnalysis";
import { getRedisConnection } from "@/lib/queue/connection";
import mongoose from "mongoose";

export const GET = withAuth(async () => {
  const health: Record<string, unknown> = {};

  try {
    await connectDB();
    health.database = { status: mongoose.connection.readyState === 1 ? "UP" : "DOWN" };
  } catch (err) {
    health.database = { status: "DOWN", error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const redis = getRedisConnection();
    await redis.ping();
    health.redis = { status: "UP" };
  } catch (err) {
    health.redis = { status: "DOWN", error: err instanceof Error ? err.message : String(err) };
  }

  const lastSync = await SyncLog.findOne({}).sort({ startedAt: -1 });
  health.jobApi = { lastSync: lastSync ? { status: lastSync.status, at: lastSync.startedAt, fetched: lastSync.jobsFetched } : null };

  const [failedAi, totalAi] = await Promise.all([
    AiAnalysis.countDocuments({ status: "FAILED" }),
    AiAnalysis.countDocuments({}),
  ]);
  health.aiApi = { status: "UP", failedRequests: failedAi, totalRequests: totalAi };

  return NextResponse.json(health);
}, "admin:manage");
