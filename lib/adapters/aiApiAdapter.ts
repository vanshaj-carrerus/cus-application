import { env } from "@/lib/env";

/**
 * Adapter around the Google Gemini (Generative Language API) generateContent endpoint.
 * The rest of the app never talks to Gemini directly — it calls analyze() / generate() /
 * structuredOutput() / classify() / embed() and gets back plain JS values.
 */

export interface GenerateOptions {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}

export interface StructuredOptions extends GenerateOptions {
  schema: Record<string, unknown>; // JSON schema (subset supported by Gemini)
}

export class AiApiError extends Error {
  constructor(message: string, public status?: number, public raw?: unknown) {
    super(message);
  }
}

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const RETRYABLE_STATUSES = new Set([429, 500, 503]);

async function callGemini(model: string, body: Record<string, unknown>, attempt = 0): Promise<GeminiResponse> {
  const url = `${env.aiApiUrl}/models/${model}:generateContent?key=${env.aiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (RETRYABLE_STATUSES.has(res.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      return callGemini(model, body, attempt + 1);
    }
    const errBody = await res.text().catch(() => "");
    throw new AiApiError(`AI API request failed: ${res.status}`, res.status, errBody);
  }

  return res.json() as Promise<GeminiResponse>;
}

function extractText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** Free-form text generation. */
export async function generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
  const model = options.model ?? env.aiModel;
  const response = await callGemini(model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
    },
  });
  return extractText(response);
}

/** Same as generate(), semantically used for "analyze this data" prompts. */
export async function analyze(prompt: string, options: GenerateOptions = {}): Promise<string> {
  return generate(prompt, options);
}

/**
 * Ask the model to return JSON that conforms to the given schema.
 * Validates that the result parses as JSON before returning it — throws otherwise
 * so callers never work with hallucinated/malformed structured output.
 */
export async function structuredOutput<T = unknown>(prompt: string, options: StructuredOptions): Promise<T> {
  const model = options.model ?? env.aiModel;
  const response = await callGemini(model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      responseMimeType: "application/json",
      responseSchema: options.schema,
    },
  });

  const text = extractText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AiApiError("AI returned invalid JSON for structured output", undefined, text);
  }
}

/** Classify text into one of a fixed set of labels. */
export async function classify(text: string, labels: string[], options: GenerateOptions = {}): Promise<string> {
  const result = await structuredOutput<{ label: string }>(
    `Classify the following text into exactly one of these labels: ${labels.join(", ")}.\n\nText:\n${text}`,
    {
      ...options,
      schema: {
        type: "object",
        properties: { label: { type: "string", enum: labels } },
        required: ["label"],
      },
    }
  );
  return result.label;
}

/** Text embedding via Gemini's embedding model. */
export async function embed(text: string): Promise<number[]> {
  const url = `${env.aiApiUrl}/models/text-embedding-004:embedContent?key=${env.aiApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) {
    throw new AiApiError(`AI embed request failed: ${res.status}`, res.status);
  }
  const data = (await res.json()) as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

export const AiApiAdapter = {
  generate,
  analyze,
  structuredOutput,
  classify,
  embed,
};
