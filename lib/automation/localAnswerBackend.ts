import type { ICandidate } from "@/lib/models/Candidate";
import type { AnswerBackend } from "@/lib/automation/formEngine";
import { askModel } from "@/lib/automation/answerModel";
import { lookupSavedAnswers, markAnswersUsed, recordNeededQuestions } from "@/lib/automation/savedAnswers";

/** The answer backend that talks straight to MongoDB and the AI providers. Used by the helper's API routes. */
export function localAnswerBackend(candidate: ICandidate): AnswerBackend {
  return {
    async lookupSaved(asked) {
      return (await lookupSavedAnswers(candidate._id as never, asked)).answers;
    },
    askModel: (questions, job, coverLetter) => askModel(questions, candidate, job, coverLetter),
    markUsed: (ids) => markAnswersUsed(ids),
    recordNeeded: (questions, askedOn) => recordNeededQuestions(candidate._id as never, questions, askedOn),
  };
}
