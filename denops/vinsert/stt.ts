import type { RuntimeConfig } from "./config.ts";
import { sanitizeText } from "./text.ts";
import { as, ensure, is, type Predicate } from "./deps/unknownutil.ts";

const isError = is.InstanceOf(Error);

export type TranscribeOptions = {
  apiKey: string;
  config: RuntimeConfig;
  onPartial?: (text: string) => void;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
};

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

type TranscriptionResponse = { text: string };
type TranscriptionChunk = { text?: string; partial?: string };

const isTranscriptionResponse = is.ObjectOf({
  text: is.String,
}) satisfies Predicate<TranscriptionResponse>;

const isTranscriptionChunk = is.ObjectOf({
  text: as.Optional(is.String),
  partial: as.Optional(is.String),
}) satisfies Predicate<TranscriptionChunk>;

export async function transcribeServer(
  wav: Uint8Array,
  options: TranscribeOptions,
): Promise<string> {
  try {
    return await transcribeSSE(wav, options);
  } catch (error) {
    const detail = isError(error) ? error.message : String(error ?? "");
    options.onStatus?.(
      `[vinsert] STT: SSE transcription failed, falling back to batch (${detail})`,
    );
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
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${body}`);
  }
  const json = ensure(await response.json(), isTranscriptionResponse);
  const text = json.text;
  if (text.length === 0) {
    throw new Error("Transcription response missing text field");
  }
  return sanitizeText(text);
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
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SSE transcription failed (${response.status}): ${body}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // API responded with JSON (no SSE). Fallback to standard handling.
    options.onStatus?.(
      "[vinsert] STT: SSE not available, falling back to batch",
    );
    const json = ensure(await response.json(), isTranscriptionResponse);
    const text = json.text;
    if (text.length > 0) {
      return text;
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
        const payload = JSON.parse(data);
        if (!isTranscriptionChunk(payload)) {
          continue;
        }
        if (payload.partial !== undefined) {
          finalText = sanitizeText(payload.partial);
          options.onPartial?.(finalText);
        } else if (payload.text !== undefined) {
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
  const file = new File([toArrayBuffer(wav)], "audio.wav", {
    type: "audio/wav",
  });
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

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(view);
  return buffer;
}
