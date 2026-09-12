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
      // Retry forever with capped exponential backoff. Giving up after N attempts
      // (the previous behavior) leaves ioredis in a permanently "Connection is
      // closed" state that never recovers even after Redis comes back — every
      // later queue call fails until the whole process restarts. Retrying forever
      // is cheap and lets a transient Redis outage self-heal instead.
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    let loggedError = false;
    global.__redisConnection.on("error", (err) => {
      if (!loggedError) {
        console.error("[redis] connection error (further errors suppressed until reconnected):", err.message);
        loggedError = true;
      }
    });
    global.__redisConnection.on("ready", () => {
      loggedError = false;
    });
  }
  return global.__redisConnection;
}
