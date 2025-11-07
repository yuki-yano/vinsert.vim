import type { RuntimeConfig } from "./config.ts";
import { sanitizeText } from "./text.ts";
import { as, is, type Predicate } from "./deps/unknownutil.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

export type GenerateOptions = {
  apiKey: string;
  config: RuntimeConfig;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
};

export type PromptMessage = {
  role: "developer" | "user";
  content: string;
};

type ResponseError = { message?: string };
type ResponseStreamChunk = {
  type?: string;
  delta?: unknown;
  error?: ResponseError;
};
type StringDeltaChunk = { text?: string };
type MessageItem = { text?: string; delta?: string };
type MessageRecord = { content?: MessageItem[] };
type NestedDelta = {
  output_text_delta?: unknown;
  text?: string;
  message?: MessageRecord;
};
type ResponseContentChunk = {
  type?: string;
  text?: string;
};
type ResponseOutputItem = {
  type?: string;
  content?: ResponseContentChunk[];
};

const isResponseError = is.ObjectOf({
  message: as.Optional(is.String),
}) satisfies Predicate<ResponseError>;

const isResponseStreamChunk = is.ObjectOf({
  type: as.Optional(is.String),
  delta: as.Optional(is.Unknown),
  error: as.Optional(isResponseError),
}) satisfies Predicate<ResponseStreamChunk>;

const isStringDeltaChunk = is.ObjectOf({
  text: as.Optional(is.String),
}) satisfies Predicate<StringDeltaChunk>;

const isMessageItem = is.ObjectOf({
  text: as.Optional(is.String),
  delta: as.Optional(is.String),
}) satisfies Predicate<MessageItem>;

const isMessageRecord = is.ObjectOf({
  content: as.Optional(is.ArrayOf(isMessageItem)),
}) satisfies Predicate<MessageRecord>;

const isNestedDelta = is.ObjectOf({
  output_text_delta: as.Optional(is.Unknown),
  text: as.Optional(is.String),
  message: as.Optional(isMessageRecord),
}) satisfies Predicate<NestedDelta>;
const isResponseContentChunk = is.ObjectOf({
  type: as.Optional(is.String),
  text: as.Optional(is.String),
}) satisfies Predicate<ResponseContentChunk>;
const isResponseOutputItem = is.ObjectOf({
  type: as.Optional(is.String),
  content: as.Optional(is.ArrayOf(isResponseContentChunk)),
}) satisfies Predicate<ResponseOutputItem>;

export async function streamGenerate(
  messages: PromptMessage[],
  options: GenerateOptions,
): Promise<void> {
  const requestOptions = {
    model: options.config.llmModel,
    reasoning: { effort: "minimal" },
    text: { verbosity: "low" },
    ...options.config.llmRequestOptions,
  };
  const shouldStream = options.config.llmStream;
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      ...requestOptions,
      ...(shouldStream ? { stream: true } : {}),
      input: messages,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Generation failed (${response.status}): ${text}`);
  }
  if (!shouldStream) {
    const payload = await response.json();
    const text = extractResponseText(payload);
    if (!text || text.length === 0) {
      throw new Error("Generation succeeded but no text was returned");
    }
    const cleaned = sanitizeDelta(text);
    if (cleaned.length > 0) {
      options.onDelta(cleaned);
    }
    return;
  }
  if (!response.body) {
    throw new Error("Generation succeeded but response did not include a body");
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
        const rawPayload = JSON.parse(data);
        if (!isResponseStreamChunk(rawPayload)) {
          continue;
        }
        if (rawPayload.type === "response.error") {
          const message = rawPayload.error?.message ??
            "Unknown streaming error";
          throw new ResponseStreamError(message);
        }
        const delta = extractTextDelta(rawPayload);
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

function extractTextDelta(payload: ResponseStreamChunk): string | undefined {
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
  if (is.String(delta)) return delta;
  if (isStringDeltaChunk(delta)) {
    const text = delta.text;
    return text ?? undefined;
  }
  return undefined;
}

function extractNestedDelta(delta: unknown): string | undefined {
  if (!delta) return undefined;
  if (is.String(delta)) return delta;
  if (!isNestedDelta(delta)) return undefined;

  const directSource = delta.output_text_delta ?? delta.text;
  const directText = extractString(directSource);
  const messageText = delta.message
    ? extractMessageText(delta.message)
    : undefined;

  if (directText && messageText) {
    return directText + messageText;
  }
  return directText ?? messageText ?? undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!isMessageRecord(message)) return undefined;
  const content = message.content;
  if (!content || content.length === 0) return undefined;
  let buffer = "";
  for (const item of content) {
    const text = item.text ?? item.delta;
    if (text) buffer += text;
  }
  return buffer.length > 0 ? buffer : undefined;
}

function extractString(value: unknown): string | undefined {
  return is.String(value) ? value : undefined;
}

function extractResponseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const outputText = (payload as { output_text?: unknown }).output_text;
  if (is.String(outputText) && outputText.length > 0) {
    return outputText;
  }
  const output = (payload as { output?: unknown }).output;
  if (is.ArrayOf(isResponseOutputItem)(output)) {
    let buffer = "";
    for (const item of output) {
      if (!item.content || item.content.length === 0) continue;
      for (const content of item.content) {
        if (content.text) buffer += content.text;
      }
    }
    if (buffer.length > 0) {
      return buffer;
    }
  }
  return undefined;
}

export function sanitizeDelta(delta: string): string {
  return sanitizeText(delta);
}
