import type { SessionPayload } from "@/lib/auth/session";

/**
 * Staff may work on any candidate's applications; a candidate login only on their own. Never trust a candidate id
 * from the request for a CANDIDATE role: compare with the one in the signed session.
 */
export function canWorkOnCandidate(user: Pick<SessionPayload, "role" | "candidateId">, candidateId: unknown): boolean {
  if (user.role !== "CANDIDATE") return true;
  return !!user.candidateId && String(candidateId) === user.candidateId;
}
