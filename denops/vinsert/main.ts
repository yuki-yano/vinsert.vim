import { type Denops, fn, helper, variable } from "./deps/denops.ts";
import { isString } from "./deps/unknownutil.ts";
import {
  loadConfig,
  type RuntimeConfig,
  type StreamingMode,
} from "./config.ts";
import {
  type RecorderHandle,
  startRecording,
  stopRecording,
} from "./recorder.ts";
import {
  finalizeUndo,
  type InsertReservation,
  insertStream,
  reserveInsertRange,
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
import { setIndicatorAnchor, setPhase } from "./indicator.ts";
import { yankToRegister } from "./yank.ts";
import { emitCompletionEvent } from "./events.ts";
import {
  buildStatusSnapshot,
  type StatusMode,
  type StatusPhase,
  toIndicatorPhase,
} from "./status.ts";
import { isDebugEnabled, logError, logInfo, logWarn } from "./logger.ts";

let phase: StatusPhase = "idle";
let currentMode: StatusMode = "insert";
let recorder: RecorderHandle | null = null;
let reservation: InsertReservation | null = null;
let scratchHandle: ScratchHandle | null = null;
let lastFinal = "";
type Anchor = { bufnr: number; row: number; col: number };
let insertAnchor: Anchor | null = null;

export function main(denops: Denops): void {
  denops.dispatcher = {
    async toggle(mode?: unknown): Promise<void> {
      if (phase === "idle") {
        await logInfo(denops, "[vinsert] toggle: begin recording").catch(
          () => {},
        );
        await beginRecording(denops, mode);
        return;
      }
      if (phase === "recording") {
        await logInfo(denops, "[vinsert] toggle: finish recording").catch(
          () => {},
        );
        await finishRecording(denops);
      }
    },
    async start(mode?: unknown): Promise<void> {
      if (phase !== "idle") {
        await logWarn(denops, "[vinsert] Recording is already in progress.");
        return;
      }
      await logInfo(denops, "[vinsert] start: begin recording");
      await beginRecording(denops, mode);
    },
    async stop(): Promise<void> {
      if (phase !== "recording") {
        await logWarn(denops, "[vinsert] Recording is not active.");
        return;
      }
      await logInfo(denops, "[vinsert] stop: finish recording");
      await finishRecording(denops);
    },
    async status(): Promise<void> {
      await helper.echo(denops, `[vinsert] phase=${phase} mode=${currentMode}`);
    },
    status_info(): Record<string, unknown> {
      return buildStatusSnapshot(phase, currentMode);
    },
    async cancel(): Promise<void> {
      await cancelRecording(denops);
    },
  };
}

async function beginRecording(denops: Denops, rawMode: unknown): Promise<void> {
  const config = await loadConfig(denops);
  currentMode = toMode(rawMode);
  try {
    await logInfo(denops, `[vinsert] beginRecording: mode=${currentMode}`);
    const debug = await isDebugEnabled(denops);
    recorder = await startRecording(config, debug);
    phase = "recording";
    lastFinal = "";
    reservation = null;
    scratchHandle = null;
    insertAnchor = await createInsertAnchor(denops);
    setIndicatorAnchor({
      bufnr: insertAnchor.bufnr,
      row: insertAnchor.row,
    });
    await setPhase(denops, toIndicatorPhase(phase), config);
    await logInfo(denops, "[vinsert] Recording started.");
  } catch (error) {
    phase = "error";
    await setPhase(denops, toIndicatorPhase(phase), config);
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
    await setPhase(denops, toIndicatorPhase(phase), config);
    const debug = await isDebugEnabled(denops);
    const wav = await stopRecording(recorder, config.keepAudio, debug);
    await logInfo(
      denops,
      `[vinsert] finishRecording: wav size=${wav.length} bytes`,
    );
    recorder = null;
    if (currentMode === "insert") {
      reservation = await ensureInsertReservation(denops);
    } else if (currentMode === "scratch") {
      scratchHandle = await prepareScratch(denops, config);
    }
    const onPartial = (text: string): void => {
      logInfo(denops, `[vinsert] STT partial length=${text.length}`).catch(
        () => {},
      );
      if (currentMode === "insert" && reservation) {
        insertStream(denops, reservation, text, { replace: true }).catch(
          () => {},
        );
      }
      if (currentMode === "scratch" && scratchHandle) {
        replaceScratch(denops, scratchHandle, text).catch(() => {});
      }
    };
    const transcript = await transcribeByMode(
      denops,
      config.sttStreamingMode,
      wav,
      {
        apiKey,
        config,
        onPartial,
        onStatus: async (message) => {
          await logInfo(denops, message).catch(() => {});
        },
      },
    );
    await logInfo(
      denops,
      `[vinsert] STT completed: length=${transcript.length}`,
    );
    phase = "gen";
    await setPhase(denops, toIndicatorPhase(phase), config);
    let batch = "";
    let flushPromise = Promise.resolve();
    const flush = (content: string): void => {
      if (!content) return;
      const toFlush = content;
      flushPromise = flushPromise.then(() => handleDelta(denops, toFlush))
        .catch((error) => {
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
    await logInfo(denops, "[vinsert] Generation finished.");
    await emitCompletionEvent(denops, currentMode, true, transcript, lastFinal);
    phase = "idle";
    await setPhase(denops, toIndicatorPhase(phase), config);
    await cleanup(denops);
  } catch (error) {
    phase = "error";
    await setPhase(denops, toIndicatorPhase(phase), config);
    await logError(denops, "[vinsert] finishRecording: error", error);
    await emitCompletionEvent(denops, currentMode, false, lastFinal, "");
    await cleanup(denops);
  }
}

async function cancelRecording(denops: Denops): Promise<void> {
  if (phase !== "recording") {
    await logWarn(denops, "[vinsert] Recording is not active.");
    return;
  }
  const config = await loadConfig(denops);
  const debug = await isDebugEnabled(denops);
  await logInfo(denops, "[vinsert] cancelRecording: aborting current session");
  try {
    await stopRecording(recorder, config.keepAudio, debug);
  } catch (error) {
    await logError(denops, "[vinsert] cancelRecording: stop failed", error);
  } finally {
    phase = "idle";
    await setPhase(denops, "idle", config);
    await emitCompletionEvent(denops, currentMode, false, "", "");
    await cleanup(denops);
    await logInfo(denops, "[vinsert] Recording canceled.");
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

function toMode(value: unknown): StatusMode {
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
  throw new Error(
    "OpenAI API key is not set. Configure the OPENAI_API_KEY environment variable or g:vinsert_openai_api_key.",
  );
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
  return {
    bufnr: sanitized.bufnr,
    row: sanitized.startRow,
    col: sanitized.startCol,
  };
}

async function ensureInsertReservation(
  denops: Denops,
): Promise<InsertReservation> {
  if (!insertAnchor) {
    const fallback = await reserveInsertRange(denops);
    insertAnchor = {
      bufnr: fallback.bufnr,
      row: fallback.startRow,
      col: fallback.startCol,
    };
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
        const message = `[vinsert] STT: SSE failed (${
          error instanceof Error ? error.message : String(error)
        })`;
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
