import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "@/lib/env";

/**
 * Multi-provider JSON-completion chain for Stage 2 tailoring: Gemini -> Mistral -> Groq
 * -> OpenRouter, each with its own fallback models. Every provider here is optional —
 * a missing API key just skips that provider rather than crashing the whole chain.
 * Callers must ask for JSON explicitly in the prompt itself: unlike a single-provider
 * tool-forced schema, this has no per-provider schema enforcement, only
 * response_format: "json_object" (OpenAI-compatible providers) / responseMimeType
 * (Gemini) plus parseJsonSafely() stripping markdown fences as a safety net.
 */

export interface EngineResult<T> {
  data: T;
  model: string;
}

function parseJsonSafely<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

async function tryGemini<T>(prompt: string): Promise<EngineResult<T>> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  const genAI = new GoogleGenerativeAI(env.geminiApiKey);
  // gemini-flash-lite-latest is Google's auto-updating alias (LTS anchor) — it keeps
  // pointing at a current Flash Lite model so this entry shouldn't need updating.
  const models = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];

  for (const modelId of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { responseMimeType: "application/json" },
      });
      const result = await model.generateContent(prompt);
      return {
        data: parseJsonSafely<T>(result.response.text()),
        model: `gemini-${modelId}`,
      };
    } catch {
      // try next model
    }
  }

  throw new Error("Gemini chain exhausted.");
}

async function tryGroqChain<T>(prompt: string): Promise<EngineResult<T>> {
  if (!env.groqApiKey) {
    throw new Error("GROQ_API_KEY is not configured.");
  }
  // openai/gpt-oss-20b is the LTS anchor (undated open-weight id, currently working on
  // this org's key). The rest need enabling at console.groq.com/settings/limits.
  const models = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "qwen/qwen3.6-27b"];

  for (const modelId of models) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.groqApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) continue;
      return {
        data: parseJsonSafely<T>(content),
        model: `groq-${modelId}`,
      };
    } catch {
      // try next provider model
    }
  }
  throw new Error("Groq chain exhausted.");
}

async function tryMistralChain<T>(prompt: string): Promise<EngineResult<T>> {
  if (!env.mistralApiKey) {
    throw new Error("MISTRAL_API_KEY is not configured.");
  }
  const models = ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"];

  for (const modelId of models) {
    try {
      const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.mistralApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) continue;
      return {
        data: parseJsonSafely<T>(content),
        model: `mistral-${modelId}`,
      };
    } catch {
      // try next provider model
    }
  }

  throw new Error("Mistral chain exhausted.");
}

async function tryOpenRouter<T>(prompt: string): Promise<EngineResult<T>> {
  if (!env.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }
  // minimax/minimax-m3:free is the heaviest-used free model on OpenRouter (most likely
  // to stay in the catalog long-term) — treated as the LTS anchor for this chain.
  const models = [
    "minimax/minimax-m3:free",
    "nvidia/nemotron-3.5-lightning:free",
    "z-ai/glm-5.2:free",
    "google/gemma-4-31b-it:free",
  ];
  for (const modelId of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openrouterApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) continue;
      return {
        data: parseJsonSafely<T>(content),
        model: `openrouter-${modelId}`,
      };
    } catch {
      // try next provider model
    }
  }
  throw new Error("OpenRouter chain exhausted.");
}

/** Runs a JSON-completion prompt through Gemini -> Mistral -> Groq -> OpenRouter, first one to succeed wins. */
export async function runJsonPrompt<T>(prompt: string): Promise<EngineResult<T>> {
  try {
    return await tryGemini<T>(prompt);
  } catch (geminiError) {
    console.warn("Gemini failed, fallback to Mistral:", geminiError);
    try {
      return await tryMistralChain<T>(prompt);
    } catch (mistralError) {
      console.warn("Mistral failed, fallback to Groq:", mistralError);
      try {
        return await tryGroqChain<T>(prompt);
      } catch (groqError) {
        console.warn("Groq failed, fallback to OpenRouter:", groqError);
        return tryOpenRouter<T>(prompt);
      }
    }
  }
}
