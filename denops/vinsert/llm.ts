import type { RuntimeConfig } from "./config.ts";
import { sanitizeText } from "./text.ts";

const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

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
  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.config.llmModel,
      stream: true,
      messages: [
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
        const payload = JSON.parse(data) as {
          choices: Array<{ delta?: { content?: string } }>;
        };
        const choice = payload.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          const cleaned = sanitizeDelta(delta);
          if (cleaned.length > 0) {
            options.onDelta(cleaned);
          }
        }
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

export function sanitizeDelta(delta: string): string {
  return sanitizeText(delta);
}
