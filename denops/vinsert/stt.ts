import type { RuntimeConfig } from "./config.ts";
import { sanitizeText } from "./text.ts";

export type TranscribeOptions = {
  apiKey: string;
  config: RuntimeConfig;
  onPartial?: (text: string) => void;
  onStatus?: (message: string) => void;
};

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

export async function transcribeServer(
  wav: Uint8Array,
  options: TranscribeOptions,
): Promise<string> {
  try {
    return await transcribeSSE(wav, options);
  } catch (error) {
    console.warn("[vinsert] SSE transcription failed, falling back to batch:", error);
    return await transcribeBatch(wav, options);
  }
}

export async function transcribeProgressive(
  wav: Uint8Array,
  options: TranscribeOptions,
): Promise<string> {
  options.onStatus?.("[vinsert] STT: progressive mode");
  return await transcribeBatch(wav, options);
}

export async function transcribeBatch(
  wav: Uint8Array,
  options: TranscribeOptions,
): Promise<string> {
  options.onStatus?.("[vinsert] STT: batch mode");
  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: buildFormData(wav, options),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${body}`);
  }
  const json = await response.json() as { text?: string };
  if (!json.text) {
    throw new Error("Transcription response missing text field");
  }
  return sanitizeText(json.text);
}

async function transcribeSSE(
  wav: Uint8Array,
  options: TranscribeOptions,
): Promise<string> {
  options.onStatus?.("[vinsert] STT: attempting SSE stream");
  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: "text/event-stream",
    },
    body: buildFormData(wav, options),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SSE transcription failed (${response.status}): ${body}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // API responded with JSON (no SSE). Fallback to standard handling.
    options.onStatus?.("[vinsert] STT: SSE not available, falling back to batch");
    const json = await response.json() as { text?: string };
    if (typeof json.text === "string" && json.text.length > 0) {
      return json.text;
    }
    throw new Error("SSE transcription not available (non-streaming response)");
  }
  if (!response.body) {
    throw new Error("SSE transcription failed: empty body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let finalText = "";
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
      if (data === "[DONE]") {
        reader.cancel().catch(() => {});
        break;
      }
      try {
        const payload = JSON.parse(data) as {
          text?: string;
          partial?: string;
        };
        if (typeof payload.partial === "string") {
          finalText = sanitizeText(payload.partial);
          options.onPartial?.(finalText);
        } else if (typeof payload.text === "string") {
          finalText = sanitizeText(payload.text);
          options.onPartial?.(finalText);
        }
      } catch {
        // ignore malformed chunk
      }
    }
  }
  if (!finalText) {
    throw new Error("SSE transcription returned empty result");
  }
  return sanitizeText(finalText);
}

function buildFormData(wav: Uint8Array, options: TranscribeOptions): FormData {
  const form = new FormData();
  const file = new File([wav], "audio.wav", { type: "audio/wav" });
  form.append("file", file);
  form.append("model", options.config.sttModel);
  form.append("response_format", "json");
  if (options.config.language) {
    form.append("language", options.config.language);
  }
  if (options.config.biasPrompt) {
    form.append("prompt", options.config.biasPrompt);
  }
  return form;
}
