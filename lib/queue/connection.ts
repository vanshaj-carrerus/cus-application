import IORedis from "ioredis";
import { env } from "@/lib/env";

declare global {
  var __redisConnection: IORedis | undefined;
}

export function getRedisConnection(): IORedis {
  if (!global.__redisConnection) {
    global.__redisConnection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      // Cap reconnect attempts so a missing local Redis doesn't spam the log
      // forever — background features degrade gracefully without it.
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 500, 5000)),
    });
    let loggedError = false;
    global.__redisConnection.on("error", (err) => {
      if (!loggedError) {
        console.error("[redis] connection error (further errors suppressed):", err.message);
        loggedError = true;
      }
    });
  }
  return global.__redisConnection;
}
