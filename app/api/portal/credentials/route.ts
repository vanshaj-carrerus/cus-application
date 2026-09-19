import { NextResponse, type NextRequest } from "next/server";
import { withAuth } from "@/lib/api/handler";
import { connectDB } from "@/lib/db/mongodb";
import { JobBoardCredential } from "@/lib/models/JobBoardCredential";
import { JOB_BOARDS, type JobBoard } from "@/lib/models/enums";
import { encryptSecret } from "@/lib/security/crypto";

function requireCandidateSession(user: { role: string; candidateId?: string }) {
  if (user.role !== "CANDIDATE" || !user.candidateId) {
    return NextResponse.json({ error: "This endpoint is for candidate logins only" }, { status: 403 });
  }
  return null;
}

function normalizeHostname(raw: string): string {
  // Accept either a bare hostname or a full URL pasted in by mistake.
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// Never return passwordEncrypted/sessionCookiesEncrypted to the client — this is a
// write-only credential store from the candidate's point of view.
export const GET = withAuth(async (_req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  await connectDB();
  const credentials = await JobBoardCredential.find({ candidateId: user.candidateId }).select(
    "board hostname boardUsername status lastUsedAt lastVerifiedAt lastError"
  );
  return NextResponse.json({ credentials });
});

export const POST = withAuth(async (req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    isDefault?: boolean;
    board?: string;
    hostname?: string;
    boardUsername?: string;
    password?: string;
  };

  if (!body.boardUsername || !body.password) {
    return NextResponse.json({ error: "boardUsername and password are required" }, { status: 400 });
  }

  // The "default" credential is a wildcard: board OTHER with no hostname, used as a
  // fallback whenever no more specific (named-board or hostname) credential matches.
  let board: JobBoard;
  let hostname: string | undefined;
  if (body.isDefault) {
    board = "OTHER";
    hostname = undefined;
  } else {
    if (!body.board || !JOB_BOARDS.includes(body.board as JobBoard)) {
      return NextResponse.json({ error: "A valid board is required" }, { status: 400 });
    }
    board = body.board as JobBoard;
    if (board === "OTHER" && !body.hostname?.trim()) {
      return NextResponse.json({ error: "A site (hostname) is required for a custom login, e.g. boards.greenhouse.io" }, { status: 400 });
    }
    hostname = board === "OTHER" ? normalizeHostname(body.hostname!) : undefined;
  }

  await connectDB();
  const credential = await JobBoardCredential.findOneAndUpdate(
    { candidateId: user.candidateId, board, hostname },
    {
      $set: {
        candidateId: user.candidateId,
        board,
        hostname,
        boardUsername: body.boardUsername,
        passwordEncrypted: encryptSecret(body.password),
        status: "ACTIVE",
        lastError: undefined,
      },
    },
    { upsert: true, new: true }
  );
  if (!credential) {
    return NextResponse.json({ error: "Failed to save credential" }, { status: 500 });
  }

  return NextResponse.json({
    credential: { board: credential.board, hostname: credential.hostname, boardUsername: credential.boardUsername, status: credential.status },
  });
});

export const DELETE = withAuth(async (req: NextRequest, { user }) => {
  const denied = requireCandidateSession(user);
  if (denied) return denied;

  const boardParam = req.nextUrl.searchParams.get("board");
  const hostnameParam = req.nextUrl.searchParams.get("hostname");
  if (!boardParam || !JOB_BOARDS.includes(boardParam as JobBoard)) {
    return NextResponse.json({ error: "A valid board is required" }, { status: 400 });
  }
  const board: JobBoard = boardParam as JobBoard;

  await connectDB();
  await JobBoardCredential.deleteOne({ candidateId: user.candidateId, board, hostname: hostnameParam ?? undefined });
  return NextResponse.json({ deleted: true });
});
