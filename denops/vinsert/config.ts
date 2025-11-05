import { type Denops, variable } from "./deps/denops.ts";
import { as, is } from "./deps/unknownutil.ts";

export type StreamingMode = "server" | "progressive" | "off" | "auto";

export type ScratchConfig = {
  split: string;
  size: number;
  focus: boolean;
  filetype: string;
};

export type IndicatorHighlights = {
  idle: string;
  rec: string;
  stt: string;
  gen: string;
  error: string;
};

export type RuntimeConfig = {
  sttModel: string;
  llmModel: string;
  llmStream: boolean;
  llmRequestOptions: Record<string, unknown>;
  language: string;
  biasPrompt: string;
  systemPrompt: string;
  sttStreamingMode: StreamingMode;
  ffmpegPath: string;
  ffmpegArgs: string[];
  textStreamFlushMs: number;
  textStreamBatchTokens: number;
  indicatorMode: "virt" | "statusline" | "cmdline" | "none";
  indicatorHighlights: IndicatorHighlights;
  keepAudio: boolean;
  alwaysYank: boolean;
  scratch: ScratchConfig;
};

const STREAMING_MODES: StreamingMode[] = [
  "server",
  "progressive",
  "off",
  "auto",
];

export const DEFAULT_INDICATOR_HIGHLIGHTS: IndicatorHighlights = {
  idle: "DiagnosticHint",
  rec: "DiagnosticError",
  stt: "DiagnosticWarn",
  gen: "DiagnosticInfo",
  error: "DiagnosticError",
};

const isHighlightOverrides = is.ObjectOf({
  idle: as.Optional(is.String),
  rec: as.Optional(is.String),
  stt: as.Optional(is.String),
  gen: as.Optional(is.String),
  error: as.Optional(is.String),
});

const DEFAULT_CONFIG: RuntimeConfig = {
  sttModel: "gpt-4o-transcribe",
  llmModel: "gpt-5-mini",
  llmStream: true,
  llmRequestOptions: {},
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
  indicatorHighlights: { ...DEFAULT_INDICATOR_HIGHLIGHTS },
  keepAudio: false,
  alwaysYank: false,
  scratch: {
    split: "botright",
    size: 10,
    focus: false,
    filetype: "markdown.vinsert",
  },
};

export async function loadConfig(denops: Denops): Promise<RuntimeConfig> {
  const sttStreamingMode = await readStringOption(
    denops,
    "vinsert_stt_streaming_mode",
  );
  const ffmpegArgs = await readArrayOption(denops, "vinsert_ffmpeg_args");
  const sttModel = await readStringOption(
    denops,
    "vinsert_stt_model",
    DEFAULT_CONFIG.sttModel,
  );
  const llmModel = await readStringOption(
    denops,
    "vinsert_text_model",
    DEFAULT_CONFIG.llmModel,
  );
  const llmRequestOptions = await readRecordOption(
    denops,
    "vinsert_text_request",
    DEFAULT_CONFIG.llmRequestOptions,
  );
  const config: RuntimeConfig = {
    sttModel,
    llmModel,
    llmStream: await readBooleanOption(
      denops,
      "vinsert_text_stream",
      DEFAULT_CONFIG.llmStream,
    ),
    llmRequestOptions,
    language: await readStringOption(
      denops,
      "vinsert_language",
      DEFAULT_CONFIG.language,
    ),
    biasPrompt: await readStringOption(
      denops,
      "vinsert_bias_prompt",
      DEFAULT_CONFIG.biasPrompt,
    ),
    systemPrompt: await readStringOption(
      denops,
      "vinsert_system_prompt",
      DEFAULT_CONFIG.systemPrompt,
    ),
    sttStreamingMode:
      STREAMING_MODES.includes(sttStreamingMode as StreamingMode)
        ? (sttStreamingMode as StreamingMode)
        : DEFAULT_CONFIG.sttStreamingMode,
    ffmpegPath: await readStringOption(
      denops,
      "vinsert_ffmpeg_path",
      DEFAULT_CONFIG.ffmpegPath,
    ),
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
    indicatorMode: normalizeIndicatorMode(
      await variable.g.get(denops, "vinsert_indicator"),
    ),
    indicatorHighlights: normalizeHighlights(
      await variable.g.get(denops, "vinsert_indicator_highlights"),
    ),
    keepAudio: await readBooleanOption(
      denops,
      "vinsert_keep_audio",
      DEFAULT_CONFIG.keepAudio,
    ),
    alwaysYank: await readBooleanOption(
      denops,
      "vinsert_always_yank",
      DEFAULT_CONFIG.alwaysYank,
    ),
    scratch: {
      split: await readStringOption(
        denops,
        "vinsert_scratch_split",
        DEFAULT_CONFIG.scratch.split,
      ),
      size: await readNumberOption(
        denops,
        "vinsert_scratch_size",
        DEFAULT_CONFIG.scratch.size,
      ),
      focus: await readBooleanOption(
        denops,
        "vinsert_scratch_focus",
        DEFAULT_CONFIG.scratch.focus,
      ),
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
  if (is.String(value) && value.length > 0) {
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
  if (is.Number(value) && Number.isFinite(value)) {
    return value;
  }
  if (is.String(value)) {
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
  if (is.Boolean(value)) {
    return value;
  }
  if (is.String(value)) {
    const lowered = value.toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return fallback;
}

async function readRecordOption(
  denops: Denops,
  name: string,
  fallback: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await variable.g.get(denops, name);
  if (is.Record(value)) {
    return clonePlainObject(value);
  }
  return clonePlainObject(fallback);
}

function clonePlainObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (is.Record(entry)) {
      result[key] = clonePlainObject(entry);
    } else if (is.Array(entry)) {
      result[key] = entry.map((item) =>
        is.Record(item) ? clonePlainObject(item) : item
      );
    } else {
      result[key] = entry;
    }
  }
  return result;
}

async function readArrayOption(
  denops: Denops,
  name: string,
): Promise<string[]> {
  const value = await variable.g.get(denops, name);
  if (is.Array(value)) {
    const safe = value.filter((item): item is string => is.String(item));
    return safe;
  }
  return [];
}

export function normalizeIndicatorMode(
  value: unknown,
): "virt" | "statusline" | "cmdline" | "none" {
  if (!is.String(value)) {
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

export function normalizeHighlights(value: unknown): IndicatorHighlights {
  const result: IndicatorHighlights = { ...DEFAULT_INDICATOR_HIGHLIGHTS };
  if (!isHighlightOverrides(value)) {
    return result;
  }
  for (const key of ["idle", "rec", "stt", "gen", "error"] as const) {
    const candidate = value[key];
    if (candidate && candidate.length > 0) {
      result[key] = candidate;
    }
  }
  return result;
}
