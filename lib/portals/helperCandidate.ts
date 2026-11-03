import { User } from "@/lib/models/User";
import { canWorkOnCandidate } from "@/lib/auth/applicationAccess";
import type { HelperUser } from "@/lib/api/helperAuth";

/**
 * Which candidate a helper request is about. A candidate's token is always pinned to its own candidate; staff name one
 * and may work on any. Returns null when there is no usable candidate.
 */
export async function resolveHelperCandidate(user: HelperUser, requested: unknown): Promise<string | null> {
  if (user.role === "CANDIDATE") {
    const login = await User.findById(user.sub).select("candidateId");
    return login?.candidateId ? String(login.candidateId) : null;
  }
  const id = typeof requested === "string" ? requested : undefined;
  return id && canWorkOnCandidate({ role: user.role, candidateId: undefined }, id) ? id : null;
}
