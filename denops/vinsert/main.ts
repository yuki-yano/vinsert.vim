import { helper, type Denops, variable, fn } from "./deps/denops.ts";
import { isString } from "./deps/unknownutil.ts";
import {
  loadConfig,
  type RuntimeConfig,
  type StreamingMode,
} from "./config.ts";
import {
  startRecording,
  stopRecording,
  type RecorderHandle,
} from "./recorder.ts";
import {
  insertStream,
  reserveInsertRange,
  finalizeUndo,
  type InsertReservation,
  sanitizeReservation,
} from "./buffer.ts";
import {
  transcribeBatch,
  transcribeProgressive,
  transcribeServer,
} from "./stt.ts";
import { streamGenerate } from "./llm.ts";
import {
  appendScratch,
  disposeScratch,
  prepareScratch,
  replaceScratch,
  type ScratchHandle,
} from "./scratch.ts";
import { setPhase, clearIndicator, setIndicatorAnchor } from "./indicator.ts";
import { yankToRegister } from "./yank.ts";
import { emitCompletionEvent } from "./events.ts";

type Phase = "idle" | "recording" | "stt" | "gen" | "error";
type Mode = "insert" | "yank" | "scratch";

let phase: Phase = "idle";
let currentMode: Mode = "insert";
let recorder: RecorderHandle | null = null;
let reservation: InsertReservation | null = null;
let scratchHandle: ScratchHandle | null = null;
let lastFinal = "";
type Anchor = { bufnr: number; row: number; col: number };
let insertAnchor: Anchor | null = null;

async function isDebugEnabled(denops: Denops): Promise<boolean> {
  const flag = await variable.g.get(denops, "vinsert_debug");
  return flag === true || flag === 1 || flag === "true";
}

async function logInfo(denops: Denops, message: string): Promise<void> {
  console.log(message);
  if (await isDebugEnabled(denops)) {
    await helper.echo(denops, message).catch(() => {});
  }
}

async function logError(denops: Denops, message: string, error?: unknown): Promise<void> {
  console.error(message, error);
  if (await isDebugEnabled(denops)) {
    const detail = error instanceof Error ? error.message : String(error ?? "");
    await helper.echoerr(denops, `${message}: ${detail}`).catch(() => {});
  }
}

export function main(denops: Denops): void {
  denops.dispatcher = {
    async toggle(mode?: unknown): Promise<void> {
      if (phase === "idle") {
        await logInfo(denops, "[vinsert] toggle: begin recording").catch(() => {});
        await beginRecording(denops, mode);
        return;
      }
      if (phase === "recording") {
        await logInfo(denops, "[vinsert] toggle: finish recording").catch(() => {});
        await finishRecording(denops);
      }
    },
    async start(mode?: unknown): Promise<void> {
      if (phase !== "idle") {
        await helper.echo(denops, "[vinsert] 既に録音処理が進行中です。");
        return;
      }
      await logInfo(denops, "[vinsert] start: begin recording");
      await beginRecording(denops, mode);
    },
    async stop(): Promise<void> {
      if (phase !== "recording") {
        await helper.echo(denops, "[vinsert] 録音中ではありません。");
        return;
      }
      await logInfo(denops, "[vinsert] stop: finish recording");
      await finishRecording(denops);
    },
    async status(): Promise<void> {
      await helper.echo(denops, `[vinsert] phase=${phase} mode=${currentMode}`);
    },
  };
}

async function beginRecording(denops: Denops, rawMode: unknown): Promise<void> {
  const config = await loadConfig(denops);
  currentMode = toMode(rawMode);
  try {
    await logInfo(denops, `[vinsert] beginRecording: mode=${currentMode}`);
    recorder = await startRecording(config);
    phase = "recording";
    lastFinal = "";
    reservation = null;
    scratchHandle = null;
    insertAnchor = await createInsertAnchor(denops);
    await setIndicatorAnchor({ bufnr: insertAnchor.bufnr, row: insertAnchor.row });
    await setPhase(denops, "rec", config);
    await helper.echo(denops, "[vinsert] 録音を開始しました。");
  } catch (error) {
    phase = "error";
    await clearIndicator(denops);
    await logError(denops, "[vinsert] beginRecording: failed", error);
    await cleanup(denops);
  }
}

async function finishRecording(denops: Denops): Promise<void> {
  const config = await loadConfig(denops);
  const apiKey = await resolveApiKey(denops);
  try {
    await logInfo(denops, "[vinsert] finishRecording: entering STT phase");
    phase = "stt";
    await setPhase(denops, "stt", config);
    const wav = await stopRecording(recorder, config.keepAudio);
    await logInfo(denops, `[vinsert] finishRecording: wav size=${wav.length} bytes`);
    recorder = null;
    if (currentMode === "insert") {
      reservation = await ensureInsertReservation(denops);
    } else if (currentMode === "scratch") {
      scratchHandle = await prepareScratch(denops, config);
    }
    const onPartial = (text: string): void => {
      logInfo(denops, `[vinsert] STT partial length=${text.length}`).catch(() => {});
      if (currentMode === "insert" && reservation) {
        insertStream(denops, reservation, text, { replace: true }).catch(() => {});
      }
      if (currentMode === "scratch" && scratchHandle) {
        replaceScratch(denops, scratchHandle, text).catch(() => {});
      }
    };
    const transcript = await transcribeByMode(denops, config.sttStreamingMode, wav, {
      apiKey,
      config,
      onPartial,
      onStatus: async (message) => {
        await logInfo(denops, message).catch(() => {});
      },
    });
    await logInfo(denops, `[vinsert] STT completed: length=${transcript.length}`);
    phase = "gen";
    await setPhase(denops, "gen", config);
    let batch = "";
    let flushPromise = Promise.resolve();
    const flush = (content: string): void => {
      if (!content) return;
      const toFlush = content;
      flushPromise = flushPromise.then(() => handleDelta(denops, toFlush)).catch((error) => {
        logError(denops, "[vinsert] flush failed", error).catch(() => {});
      });
    };
    await streamGenerate(transcript, {
      apiKey,
      config,
      onDelta: (delta) => {
        batch += delta;
        lastFinal += delta;
        const threshold = Math.max(config.textStreamBatchTokens, 1) * 4;
        if (batch.length >= threshold) {
          const content = batch;
          batch = "";
          flush(content);
        }
      },
    });
    await flushPromise;
    if (batch.length > 0) {
      await handleDelta(denops, batch);
    }
    if (currentMode === "yank") {
      await yankToRegister(denops, lastFinal, '"');
    }
    if (currentMode === "insert") {
      await finalizeUndo(denops);
    }
    await helper.echo(denops, "[vinsert] 生成が完了しました。");
    await emitCompletionEvent(denops, currentMode, true, transcript, lastFinal);
    phase = "idle";
    await setPhase(denops, "idle", config);
    await cleanup(denops);
  } catch (error) {
    phase = "error";
    await setPhase(denops, "error", config);
    await logError(denops, "[vinsert] finishRecording: error", error);
    await emitCompletionEvent(denops, currentMode, false, lastFinal, "");
    await cleanup(denops);
  }
}

async function handleDelta(denops: Denops, delta: string): Promise<void> {
  if (!delta) return;
  if (currentMode === "insert" && reservation) {
    await insertStream(denops, reservation, delta, { append: true });
  } else if (currentMode === "scratch" && scratchHandle) {
    await appendScratch(denops, scratchHandle, delta);
  }
}

function toMode(value: unknown): Mode {
  if (!isString(value) || value.length === 0) {
    return "insert";
  }
  const lowered = value.toLowerCase();
  if (lowered === "yank") return "yank";
  if (lowered === "scratch") return "scratch";
  return "insert";
}

async function resolveApiKey(denops: Denops): Promise<string> {
  const envKey = Deno.env.get("OPENAI_API_KEY");
  if (envKey && envKey.length > 0) {
    return envKey;
  }
  const vimKey = await variable.g.get(denops, "vinsert_openai_api_key");
  if (isString(vimKey) && vimKey.length > 0) {
    return vimKey;
  }
  throw new Error("OpenAI API キーが設定されていません。環境変数 OPENAI_API_KEY または g:vinsert_openai_api_key を設定してください。");
}

async function cleanup(denops: Denops): Promise<void> {
  recorder = null;
  reservation = null;
  if (scratchHandle) {
    await disposeScratch(denops, scratchHandle).catch(() => {});
  }
  scratchHandle = null;
  lastFinal = "";
  phase = "idle";
  insertAnchor = null;
}

async function createInsertAnchor(denops: Denops): Promise<Anchor> {
  const bufnr = await fn.bufnr(denops, "%") as number;
  const pos = await fn.getpos(denops, ".") as unknown[];
  const startRow = Math.max(Number(pos[1]) - 1, 0);
  const startCol = Math.max(Number(pos[2]) - 1, 0);
  const sanitized = await sanitizeReservation(denops, {
    bufnr,
    startRow,
    startCol,
    endRow: startRow,
    endCol: startCol,
  }, false);
  return { bufnr: sanitized.bufnr, row: sanitized.startRow, col: sanitized.startCol };
}

async function ensureInsertReservation(denops: Denops): Promise<InsertReservation> {
  if (!insertAnchor) {
    const fallback = await reserveInsertRange(denops);
    insertAnchor = { bufnr: fallback.bufnr, row: fallback.startRow, col: fallback.startCol };
    return fallback;
  }
  return await sanitizeReservation(denops, {
    bufnr: insertAnchor.bufnr,
    startRow: insertAnchor.row,
    startCol: insertAnchor.col,
    endRow: insertAnchor.row,
    endCol: insertAnchor.col,
  }, false);
}

async function transcribeByMode(
  denops: Denops,
  mode: StreamingMode,
  wav: Uint8Array,
  options: {
    apiKey: string;
    config: RuntimeConfig;
    onPartial: (text: string) => void;
    onStatus?: (message: string) => void;
  },
): Promise<string> {
  switch (mode) {
    case "server":
      return await transcribeServer(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onPartial: options.onPartial,
        onStatus: options.onStatus,
      });
    case "progressive":
      return await transcribeProgressive(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onPartial: options.onPartial,
        onStatus: options.onStatus,
      });
    case "off":
      return await transcribeBatch(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onStatus: options.onStatus,
      });
    case "auto":
    default:
      try {
        return await transcribeServer(wav, {
          apiKey: options.apiKey,
          config: options.config,
          onPartial: options.onPartial,
          onStatus: options.onStatus,
        });
      } catch (error) {
        const message = `[vinsert] STT: SSE failed (${error instanceof Error ? error.message : String(error)})`;
        options.onStatus?.(message);
        await logError(denops, message, error);
        return await transcribeProgressive(wav, {
          apiKey: options.apiKey,
          config: options.config,
          onPartial: options.onPartial,
          onStatus: options.onStatus,
        });
      }
  }
}
