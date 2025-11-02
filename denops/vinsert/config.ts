import { type Denops, variable } from "./deps/denops.ts";
import { isString } from "./deps/unknownutil.ts";

export type StreamingMode = "server" | "progressive" | "off" | "auto";

export type ScratchConfig = {
  split: string;
  size: number;
  focus: boolean;
  filetype: string;
};

export type RuntimeConfig = {
  sttModel: string;
  llmModel: string;
  language: string;
  biasPrompt: string;
  systemPrompt: string;
  sttStreamingMode: StreamingMode;
  ffmpegPath: string;
  ffmpegArgs: string[];
  textStreamFlushMs: number;
  textStreamBatchTokens: number;
  indicatorMode: "virt" | "statusline" | "cmdline" | "none";
  keepAudio: boolean;
  scratch: ScratchConfig;
};

const STREAMING_MODES: StreamingMode[] = ["server", "progressive", "off", "auto"];

const DEFAULT_CONFIG: RuntimeConfig = {
  sttModel: "gpt-4o-transcribe",
  llmModel: "gpt-5-mini",
  language: "ja",
  biasPrompt: "",
  systemPrompt:
    "あなたは日本語の音声起こしアシスタントです。話者が発した語句をそのままの語尾で残し、発話していない単語や語尾を補わないこと。句読点や改行は読みやすさのために付与してよいが、意味内容を変えたり語尾を変化させたりしてはならない。",
  sttStreamingMode: "auto",
  ffmpegPath: "ffmpeg",
  ffmpegArgs: [],
  textStreamFlushMs: 50,
  textStreamBatchTokens: 20,
  indicatorMode: "virt",
  keepAudio: false,
  scratch: {
    split: "botright",
    size: 10,
    focus: false,
    filetype: "markdown.vinsert",
  },
};

export async function loadConfig(denops: Denops): Promise<RuntimeConfig> {
  const sttStreamingMode = await readStringOption(denops, "vinsert_stt_streaming_mode");
  const ffmpegArgs = await readArrayOption(denops, "vinsert_ffmpeg_args");
  const config: RuntimeConfig = {
    sttModel: await readStringOption(denops, "vinsert_stt_model", DEFAULT_CONFIG.sttModel),
    llmModel: await readStringOption(denops, "vinsert_text_model", DEFAULT_CONFIG.llmModel),
    language: await readStringOption(denops, "vinsert_language", DEFAULT_CONFIG.language),
    biasPrompt: await readStringOption(denops, "vinsert_bias_prompt", DEFAULT_CONFIG.biasPrompt),
    systemPrompt: await readStringOption(denops, "vinsert_system_prompt", DEFAULT_CONFIG.systemPrompt),
    sttStreamingMode: STREAMING_MODES.includes(sttStreamingMode as StreamingMode)
      ? (sttStreamingMode as StreamingMode)
      : DEFAULT_CONFIG.sttStreamingMode,
    ffmpegPath: await readStringOption(denops, "vinsert_ffmpeg_path", DEFAULT_CONFIG.ffmpegPath),
    ffmpegArgs: ffmpegArgs,
    textStreamFlushMs: await readNumberOption(
      denops,
      "vinsert_text_stream_flush_ms",
      DEFAULT_CONFIG.textStreamFlushMs,
    ),
    textStreamBatchTokens: await readNumberOption(
      denops,
      "vinsert_text_stream_batch_tokens",
      DEFAULT_CONFIG.textStreamBatchTokens,
    ),
    indicatorMode: normalizeIndicatorMode(await variable.g.get(denops, "vinsert_indicator")),
    keepAudio: await readBooleanOption(denops, "vinsert_keep_audio", DEFAULT_CONFIG.keepAudio),
    scratch: {
      split: await readStringOption(denops, "vinsert_scratch_split", DEFAULT_CONFIG.scratch.split),
      size: await readNumberOption(denops, "vinsert_scratch_size", DEFAULT_CONFIG.scratch.size),
      focus: await readBooleanOption(denops, "vinsert_scratch_focus", DEFAULT_CONFIG.scratch.focus),
      filetype: "markdown.vinsert",
    },
  };
  return config;
}

async function readStringOption(
  denops: Denops,
  name: string,
  fallback = "",
): Promise<string> {
  const value = await variable.g.get(denops, name);
  if (isString(value) && value.length > 0) {
    return value;
  }
  return fallback;
}

async function readNumberOption(
  denops: Denops,
  name: string,
  fallback: number,
): Promise<number> {
  const value = await variable.g.get(denops, name);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (isString(value)) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

async function readBooleanOption(
  denops: Denops,
  name: string,
  fallback: boolean,
): Promise<boolean> {
  const value = await variable.g.get(denops, name);
  if (typeof value === "boolean") {
    return value;
  }
  if (isString(value)) {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return fallback;
}

async function readArrayOption(
  denops: Denops,
  name: string,
): Promise<string[]> {
  const value = await variable.g.get(denops, name);
  if (Array.isArray(value)) {
    const safe = value.filter((item): item is string => typeof item === "string");
    return safe;
  }
  return [];
}

export function normalizeIndicatorMode(value: unknown): "virt" | "statusline" | "cmdline" | "none" {
  if (!isString(value)) {
    return DEFAULT_CONFIG.indicatorMode;
  }
  switch (value) {
    case "virt":
    case "statusline":
    case "cmdline":
    case "none":
      return value;
    default:
      return DEFAULT_CONFIG.indicatorMode;
  }
}
