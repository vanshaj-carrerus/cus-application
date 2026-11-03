import type { Types } from "mongoose";
import { SavedAnswer, type ISavedAnswer } from "@/lib/models/SavedAnswer";

/**
 * Question matching for the saved-answers library. Forms word the same question many ways ("Are you legally
 * authorized to work in the United States? *" / "Authorized to work in the US?"), so lookup is: exact match on a
 * normalised key first, then a close-enough word-overlap match — strict, because a wrong match would put the
 * wrong answer on a real application.
 */

// Words that carry no meaning for deciding whether two questions are the same. Negations ("not", "no") are NOT here.
const FILLER = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "you", "your", "do", "does", "are", "is", "have", "has", "will", "would", "can", "please", "if", "any", "be", "this", "that", "with", "by", "at", "as", "it", "legally", "currently", "presently", "now", "future", "visa", "also", "ever"]);

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(required\)|\*/g, " ")
    .replace(/\bu\.?\s?s\.?\s?a?\b\.?|\bunited states( of america)?\b|\bamerica\b/g, " us ")
    .replace(/\bauthori[sz]ed\b|\bauthori[sz]ation\b|\beligible\b|\bpermitted\b/g, " authorized ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentWords(key: string): string[] {
  return key.split(" ").filter((w) => w.length > 1 && !FILLER.has(w));
}

/** Same words, ignoring filler — "authorized work US" etc. Needs a real overlap AND no extra distinct words on either side. */
function similar(a: string, b: string): boolean {
  // A negation on one side only makes it the OPPOSITE question ("willing to relocate" vs "NOT willing to relocate").
  const NEGATION = /\b(not|no|never|without|none|neither|nor|cannot|cant|dont|wont|isnt|arent)\b/;
  const bare = (k: string) => k.replace(/n t\b/g, "nt");
  if (NEGATION.test(bare(a)) !== NEGATION.test(bare(b))) return false;
  const wa = new Set(contentWords(a));
  const wb = new Set(contentWords(b));
  if (wa.size < 2 || wb.size < 2) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const smaller = Math.min(wa.size, wb.size);
  const larger = Math.max(wa.size, wb.size);
  return shared / smaller >= 0.85 && shared / larger >= 0.6;
}

export interface AnswerLookup {
  /** Answer text for each asked question id that has one. */
  answers: Map<string, { answer: string; savedId: string }>;
}

/** Saved ANSWERED rows that match the asked questions (exact key first, then close wording). */
export async function lookupSavedAnswers(candidateId: Types.ObjectId | string, asked: Array<{ id: string; label: string }>): Promise<AnswerLookup> {
  const rows = await SavedAnswer.find({ candidateId, status: "ANSWERED", answer: { $ne: "" } }).lean();
  const answers = new Map<string, { answer: string; savedId: string }>();
  if (rows.length === 0) return { answers };

  const byKey = new Map(rows.map((r) => [r.questionKey, r]));
  for (const q of asked) {
    const key = normalizeQuestion(q.label);
    if (!key) continue;
    const hit = byKey.get(key) ?? rows.find((r) => similar(key, r.questionKey));
    if (hit) answers.set(q.id, { answer: hit.answer, savedId: String(hit._id) });
  }
  return { answers };
}

export async function markAnswersUsed(savedIds: string[]): Promise<void> {
  if (savedIds.length === 0) return;
  await SavedAnswer.updateMany({ _id: { $in: savedIds } }, { $inc: { timesUsed: 1 }, $set: { lastUsedAt: new Date() } });
}

/**
 * Remember required questions the bot could not answer, so a person answers each ONCE. Never overwrites an existing
 * row (an ANSWERED one stays as it is); a NEEDED one just keeps its first-seen details.
 */
export async function recordNeededQuestions(candidateId: Types.ObjectId | string, questions: Array<{ label: string; options?: string[] }>, askedOn?: string): Promise<number> {
  let created = 0;
  for (const q of questions) {
    const questionKey = normalizeQuestion(q.label);
    if (!questionKey || questionKey.length < 4) continue;
    const exists = await SavedAnswer.exists({ candidateId, questionKey });
    if (exists) continue;
    // A close wording of something already answered is covered by lookup; don't ask the person twice.
    const answered = await SavedAnswer.find({ candidateId, status: "ANSWERED" }).select("questionKey").lean();
    if (answered.some((r) => similar(questionKey, r.questionKey))) continue;
    try {
      await SavedAnswer.create({ candidateId, questionKey, question: q.label.trim().slice(0, 400), answer: "", status: "NEEDED", source: "BOT", options: q.options?.length ? q.options.slice(0, 60) : undefined, askedOn });
      created++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // lost a race with another run — fine
    }
  }
  return created;
}

export type { ISavedAnswer };
