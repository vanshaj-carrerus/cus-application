import { SavedAnswer } from "@/lib/models/SavedAnswer";
import { normalizeQuestion } from "@/lib/automation/savedAnswers";

/** Shared by the recruiter screens and the candidate portal, so both enforce the same rules. */

const MAX_QUESTION = 400;
const MAX_ANSWER = 4000;

export class AnswerError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Questions waiting for a person first, then answered ones, newest first. */
export async function listAnswers(candidateId: string) {
  // Earlier runs saved some questions under a field id ("radio-group-_r_1q_") instead of the question's words. Nobody can answer those.
  await SavedAnswer.deleteMany({ candidateId, status: "NEEDED", source: "BOT", question: { $regex: "^[A-Za-z0-9_.:]*[-_0-9][A-Za-z0-9_.:-]*$" } });
  const rows = await SavedAnswer.find({ candidateId }).sort({ updatedAt: -1 }).lean();
  return rows.sort((a, b) => Number(b.status === "NEEDED") - Number(a.status === "NEEDED"));
}

export async function createAnswer(candidateId: string, input: { question?: unknown; answer?: unknown }, source: "STAFF" | "CANDIDATE") {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (question.length < 4 || question.length > MAX_QUESTION) throw new AnswerError(`The question must be 4-${MAX_QUESTION} characters`);
  if (!answer || answer.length > MAX_ANSWER) throw new AnswerError(`The answer must be 1-${MAX_ANSWER} characters`);
  const questionKey = normalizeQuestion(question);
  if (!questionKey) throw new AnswerError("The question has no readable text");

  // The same question again just updates it (including filling in one the bot recorded as needed).
  return SavedAnswer.findOneAndUpdate(
    { candidateId, questionKey },
    { $set: { question, answer, status: "ANSWERED", source }, $setOnInsert: { timesUsed: 0 } },
    { upsert: true, returnDocument: "after" }
  );
}

export async function updateAnswer(candidateId: string, answerId: string, input: { answer?: unknown }, source: "STAFF" | "CANDIDATE") {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (!answer || answer.length > MAX_ANSWER) throw new AnswerError(`The answer must be 1-${MAX_ANSWER} characters`);
  // candidateId in the filter is the ownership check: nobody edits another candidate's answers by guessing an id.
  const row = await SavedAnswer.findOneAndUpdate({ _id: answerId, candidateId }, { $set: { answer, status: "ANSWERED", source } }, { returnDocument: "after" });
  if (!row) throw new AnswerError("Answer not found", 404);
  return row;
}

export async function deleteAnswer(candidateId: string, answerId: string) {
  const res = await SavedAnswer.deleteOne({ _id: answerId, candidateId });
  if (res.deletedCount === 0) throw new AnswerError("Answer not found", 404);
}
