import type { RuntimeConfig } from "./config.ts";
import { sanitizeText } from "./text.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

export type GenerateOptions = {
  apiKey: string;
  config: RuntimeConfig;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
};

export async function streamGenerate(
  prompt: string,
  options: GenerateOptions,
): Promise<void> {
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.config.llmModel,
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      stream: true,
      input: [
        { role: "system", content: options.config.systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Generation failed (${response.status}): ${text}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      try {
        const payload = JSON.parse(data) as ResponseStreamChunk;
        if (payload.type === "response.error") {
          const message = payload.error?.message ?? "Unknown streaming error";
          throw new ResponseStreamError(message);
        }
        const delta = extractTextDelta(payload);
        if (delta && delta.length > 0) {
          const cleaned = sanitizeDelta(delta);
          if (cleaned.length > 0) {
            options.onDelta(cleaned);
          }
        }
      } catch (error) {
        if (error instanceof ResponseStreamError) {
          throw error;
        }
        // ignore malformed chunk
      }
    }
  }
}

class ResponseStreamError extends Error {}

type ResponseStreamChunk = {
  type?: string;
  delta?: unknown;
  error?: { message?: string };
};

function extractTextDelta(payload: ResponseStreamChunk): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  switch (payload.type) {
    case "response.output_text.delta":
      return extractStringDelta(payload.delta);
    case "response.delta":
      return extractNestedDelta(payload.delta);
    default:
      return undefined;
  }
}

function extractStringDelta(delta: unknown): string | undefined {
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function extractNestedDelta(delta: unknown): string | undefined {
  if (!delta) return undefined;
  if (typeof delta === "string") return delta;
  if (typeof delta !== "object") return undefined;

  const directText = extractString(
    (delta as { output_text_delta?: unknown }).output_text_delta ??
      (delta as { text?: unknown }).text,
  );
  const message = (delta as { message?: unknown }).message;
  const messageText = extractMessageText(message);

  if (directText && messageText) {
    return directText + messageText;
  }
  return directText ?? messageText ?? undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  let buffer = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = extractString(
      (item as { text?: unknown }).text ??
        (item as { delta?: unknown }).delta,
    );
    if (text) buffer += text;
  }
  return buffer.length > 0 ? buffer : undefined;
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sanitizeDelta(delta: string): string {
  return sanitizeText(delta);
}
