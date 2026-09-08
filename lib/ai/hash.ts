import { createHash } from "crypto";

export function stableHash(input: unknown): string {
  const json = JSON.stringify(input, Object.keys(input as object).sort());
  return createHash("sha256").update(json).digest("hex");
}
