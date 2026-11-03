import { PortalConnection } from "@/lib/models/PortalConnection";
import { PortalSnapshot } from "@/lib/models/PortalSnapshot";
import { encryptSecret } from "@/lib/security/crypto";
import { getPortal } from "@/lib/portals/catalog";

export class PortalConnectionError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Public shape — the encrypted password never leaves the server. */
function toPublic(c: InstanceType<typeof PortalConnection>) {
  return {
    _id: String(c._id),
    portal: c.portal,
    loginId: c.loginId,
    status: c.status,
    statusNote: c.statusNote,
    profileUrl: c.profileUrl,
    lastVerifiedAt: c.lastVerifiedAt,
    updatedAt: c.updatedAt,
  };
}

export async function listConnections(candidateId: string) {
  const rows = await PortalConnection.find({ candidateId }).sort({ portal: 1 });
  return rows.map(toPublic);
}

export async function saveConnection(
  candidateId: string,
  userId: string,
  input: { portal?: string; loginId?: string; password?: string; profileUrl?: string }
) {
  const portal = input.portal ? getPortal(input.portal) : undefined;
  if (!input.portal || !portal) throw new PortalConnectionError("Unknown portal");
  const loginId = input.loginId?.trim();
  if (!loginId) throw new PortalConnectionError("Login ID is required");
  if (!input.password && !portal.extensionSync && !portal.loginInBrowser) throw new PortalConnectionError("Password is required");
  const profileUrl = input.profileUrl?.trim() || undefined;
  if (portal.profileUrlRequired && !profileUrl) throw new PortalConnectionError(`${portal.name} profile URL is required`);
  if (profileUrl && !/^https?:\/\//i.test(profileUrl)) throw new PortalConnectionError("Profile URL must start with http:// or https://");

  // Re-saving resets to PENDING: the new credentials haven't been verified.
  const row = await PortalConnection.findOneAndUpdate(
    { candidateId, portal: input.portal },
    {
      $set: { loginId, profileUrl, status: "PENDING", connectedByUserId: userId, ...(input.password ? { encryptedPassword: encryptSecret(input.password) } : {}) },
      $unset: { statusNote: "", lastVerifiedAt: "" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return toPublic(row);
}

export async function removeConnection(candidateId: string, id: string) {
  const row = await PortalConnection.findOneAndDelete({ _id: id, candidateId });
  if (!row) throw new PortalConnectionError("Connection not found", 404);
  // Disconnecting also removes what was read from that account.
  await PortalSnapshot.deleteOne({ candidateId, portal: row.portal });
}
