import mongoose from "mongoose";
import { env } from "@/lib/env";
// Side-effect import: registers every model's schema on this mongoose connection.
// Without this, whether a .populate("someRef") call works depends on whether some
// unrelated code path happened to import that specific model file first in this
// process — a MissingSchemaError trap that's easy to hit intermittently across
// routes/workers. Importing the whole barrel here once makes registration order
// a non-issue everywhere connectDB() is called.
import "@/lib/models";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var __mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = global.__mongooseCache ?? { conn: null, promise: null };
global.__mongooseCache = cache;

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    cache.promise = mongoose.connect(env.mongodbUri, {
      bufferCommands: false,
      maxPoolSize: 10,
    });
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    throw err;
  }

  return cache.conn;
}
