import { type Denops, fn, helper, variable } from "./deps/denops.ts";
import { isString } from "./deps/unknownutil.ts";
import {
  loadConfig,
  type RuntimeConfig,
  type StreamingMode,
} from "./config.ts";
import { startRecording, stopRecording } from "./recorder.ts";
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
import { appendScratch, prepareScratch, replaceScratch } from "./scratch.ts";
import {
  getIndicatorAnchor,
  refreshIndicator,
  setIndicatorAnchor,
  setPhase,
} from "./indicator.ts";
import { yankToRegister } from "./yank.ts";
import { emitCompletionEvent } from "./events.ts";
import {
  buildStatusSnapshot,
  type StatusMode,
  type StatusPhase,
  toIndicatorPhase,
} from "./status.ts";
import { logError, logInfo, logWarn } from "./logger.ts";
import {
  createSessionContext,
  generateSessionId,
  isLatestSession,
  selectNextActiveSession,
  type SessionContext,
} from "./session.ts";

type SessionId = string;

const sessions = new Map<SessionId, SessionContext>();
let activeSessionId: SessionId | null = null;
type AnchorPosition = { bufnr: number; row: number; col: number };

export function main(denops: Denops): void {
  denops.dispatcher = {
    async toggle(mode?: unknown): Promise<void> {
      const recording = getRecordingSession();
      if (!recording) {
        await logInfo(denops, "[vinsert] toggle: begin recording").catch(
          () => {},
        );
        await beginRecording(denops, mode);
        return;
      }
      await logInfo(denops, "[vinsert] toggle: finish recording").catch(
        () => {},
      );
      await finishRecording(denops, recording.id);
    },
    async start(mode?: unknown): Promise<void> {
      if (getRecordingSession()) {
        await logWarn(
          denops,
          "[vinsert] Recording is already in progress.",
        );
        return;
      }
      await logInfo(denops, "[vinsert] start: begin recording");
      await beginRecording(denops, mode);
    },
    async stop(): Promise<void> {
      const recording = getRecordingSession();
      if (!recording) {
        await logWarn(denops, "[vinsert] Recording is not active.");
        return;
      }
      await logInfo(denops, "[vinsert] stop: finish recording");
      await finishRecording(denops, recording.id);
    },
    async status(): Promise<void> {
      const active = getActiveSession();
      const phase = active?.phase ?? "idle";
      const mode = active?.mode ?? "insert";
      const id = active?.id ?? "-";
      await helper.echo(
        denops,
        `[vinsert] phase=${phase} mode=${mode} session=${id}`,
      );
    },
    status_info(): Record<string, unknown> {
      const active = getActiveSession();
      return buildStatusSnapshot(
        active?.phase ?? "idle",
        active?.mode ?? "insert",
      );
    },
    async refresh_indicator(): Promise<void> {
      const active = getActiveSession();
      if (!active || !active.indicatorAnchor) {
        return;
      }
      setIndicatorAnchor(active.indicatorAnchor);
      await refreshIndicator(denops, active.config);
      const updatedAnchor = getIndicatorAnchor();
      if (updatedAnchor) {
        active.indicatorAnchor = updatedAnchor;
      }
    },
    async cancel(): Promise<void> {
      const target = getCancelableSession();
      if (!target) {
        await logWarn(denops, "[vinsert] No session in progress.");
        return;
      }
      await cancelRecording(denops, target.id);
    },
  };
}

async function beginRecording(denops: Denops, rawMode: unknown): Promise<void> {
  const config = await loadConfig(denops);
  const mode = toMode(rawMode);
  const sessionId = generateSessionId();
  const session = createSessionContext(sessionId, mode, config);
  sessions.set(sessionId, session);
  try {
    await logInfo(
      denops,
      `[vinsert] beginRecording: session=${sessionId} mode=${mode}`,
    );
    const anchor = await createInsertAnchor(denops);
    session.insertAnchor = anchor;
    session.indicatorAnchor = { bufnr: anchor.bufnr, row: anchor.row };
    await focusSession(denops, sessionId);
    session.recorder = await startRecording(denops, config);
    session.lastFinal = "";
    session.reservation = null;
    session.scratchHandle = null;
    await updateSessionPhase(denops, sessionId, "recording");
    await logInfo(denops, "[vinsert] Recording started.");
  } catch (error) {
    await updateSessionPhase(denops, sessionId, "error");
    await logError(denops, "[vinsert] beginRecording: failed", error);
    await cleanupSession(denops, sessionId);
  }
}

async function finishRecording(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  const apiKey = await resolveApiKey(denops);
  try {
    await logInfo(
      denops,
      `[vinsert] finishRecording: session=${sessionId} entering STT phase`,
    );
    await updateSessionPhase(denops, sessionId, "stt");
    if (!session.recorder) {
      throw new Error("Recorder handle is missing.");
    }
    const wav = await stopRecording(
      denops,
      session.recorder,
      session.config.keepAudio,
    );
    session.recorder = null;
    await logInfo(
      denops,
      `[vinsert] finishRecording: wav size=${wav.length} bytes`,
    );
    if (session.mode === "insert") {
      session.reservation = await ensureSessionInsertReservation(
        denops,
        session,
      );
    } else if (session.mode === "scratch") {
      session.scratchHandle = await prepareScratch(denops, session.config);
    }
    const onPartial = (text: string): void => {
      logInfo(
        denops,
        `[vinsert] STT partial length=${text.length} session=${sessionId}`,
      ).catch(() => {});
      const current = sessions.get(sessionId);
      if (!current || current.canceled) {
        return;
      }
      if (current.mode === "insert" && current.reservation) {
        insertStream(denops, current.reservation, text, { replace: true })
          .catch(
            () => {},
          );
      }
      if (current.mode === "scratch" && current.scratchHandle) {
        replaceScratch(denops, current.scratchHandle, text).catch(() => {});
      }
    };
    session.sttController = new AbortController();
    const sttSignal = session.sttController.signal;
    let transcript = "";
    try {
      transcript = await transcribeByMode(
        denops,
        session.config.sttStreamingMode,
        wav,
        {
          apiKey,
          config: session.config,
          onPartial,
          onStatus: async (message) => {
            await logInfo(denops, message).catch(() => {});
          },
          signal: sttSignal,
        },
      );
    } finally {
      session.sttController = null;
    }
    const current = sessions.get(sessionId);
    if (!current || current.canceled) {
      return;
    }
    await logInfo(
      denops,
      `[vinsert] STT completed: length=${transcript.length}`,
    );
    await updateSessionPhase(denops, sessionId, "gen");
    let batch = "";
    const threshold = Math.max(session.config.textStreamBatchTokens, 1) * 4;
    const flush = (content: string): void => {
      if (!content) return;
      const pending = sessions.get(sessionId);
      if (!pending) return;
      pending.flushPromise = pending.flushPromise.then(() =>
        handleSessionDelta(denops, sessionId, content)
      )
        .catch((error) => {
          logError(denops, "[vinsert] flush failed", error).catch(() => {});
        });
    };
    session.genController = new AbortController();
    const genSignal = session.genController.signal;
    try {
      await streamGenerate(transcript, {
        apiKey,
        config: session.config,
        signal: genSignal,
        onDelta: (delta) => {
          const currentSession = sessions.get(sessionId);
          if (!currentSession || currentSession.canceled) {
            return;
          }
          batch += delta;
          currentSession.lastFinal += delta;
          if (batch.length >= threshold) {
            const content = batch;
            batch = "";
            flush(content);
          }
        },
      });
    } finally {
      session.genController = null;
    }
    const latest = sessions.get(sessionId);
    if (!latest || latest.canceled) {
      return;
    }
    await latest.flushPromise;
    if (batch.length > 0) {
      await handleSessionDelta(denops, sessionId, batch);
    }
    const shouldYank = latest.mode === "yank" || latest.config.alwaysYank;
    if (shouldYank) {
      await yankToRegister(denops, latest.lastFinal, '"');
    }
    if (latest.mode === "insert") {
      await finalizeUndo(denops);
    }
    await logInfo(denops, "[vinsert] Generation finished.");
    await emitCompletionEvent(
      denops,
      latest.mode,
      true,
      transcript,
      latest.lastFinal,
    );
    await updateSessionPhase(denops, sessionId, "idle");
    await cleanupSession(denops, sessionId);
  } catch (error) {
    session.sttController = null;
    session.genController = null;
    if (session.canceled || isAbortError(error)) {
      return;
    }
    const context = sessions.get(sessionId);
    if (context) {
      await updateSessionPhase(denops, sessionId, "error");
    }
    await logError(denops, "[vinsert] finishRecording: error", error);
    const target = context ?? session;
    await emitCompletionEvent(
      denops,
      target.mode,
      false,
      context?.lastFinal ?? session.lastFinal,
      "",
    );
    await cleanupSession(denops, sessionId);
  }
}

async function cancelRecording(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    await logWarn(denops, "[vinsert] Recording is not active.");
    return;
  }
  await logInfo(
    denops,
    `[vinsert] cancelRecording: aborting session=${sessionId}`,
  );
  try {
    if (session.recorder) {
      await stopRecording(denops, session.recorder, session.config.keepAudio);
    }
  } catch (error) {
    await logError(denops, "[vinsert] cancelRecording: stop failed", error);
  } finally {
    if (session.sttController) {
      session.sttController.abort();
    }
    if (session.genController) {
      session.genController.abort();
    }
    session.recorder = null;
    session.sttController = null;
    session.genController = null;
    session.canceled = true;
    await updateSessionPhase(denops, sessionId, "idle");
    await emitCompletionEvent(denops, session.mode, false, "", "");
    await cleanupSession(denops, sessionId);
    await logInfo(denops, "[vinsert] Recording canceled.");
  }
}

async function handleSessionDelta(
  denops: Denops,
  sessionId: SessionId,
  delta: string,
): Promise<void> {
  if (!delta) return;
  const session = sessions.get(sessionId);
  if (!session || session.canceled) return;
  if (session.mode === "insert" && session.reservation) {
    await insertStream(denops, session.reservation, delta, { append: true });
  } else if (session.mode === "scratch" && session.scratchHandle) {
    await appendScratch(denops, session.scratchHandle, delta);
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

async function createInsertAnchor(denops: Denops): Promise<AnchorPosition> {
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

async function ensureSessionInsertReservation(
  denops: Denops,
  session: SessionContext,
): Promise<InsertReservation> {
  if (!session.insertAnchor) {
    const fallback = await reserveInsertRange(denops);
    session.insertAnchor = {
      bufnr: fallback.bufnr,
      row: fallback.startRow,
      col: fallback.startCol,
    };
    session.indicatorAnchor = {
      bufnr: fallback.bufnr,
      row: fallback.startRow,
    };
    return fallback;
  }
  const sanitized = await sanitizeReservation(denops, {
    bufnr: session.insertAnchor.bufnr,
    startRow: session.insertAnchor.row,
    startCol: session.insertAnchor.col,
    endRow: session.insertAnchor.row,
    endCol: session.insertAnchor.col,
  }, false);
  session.insertAnchor = {
    bufnr: sanitized.bufnr,
    row: sanitized.startRow,
    col: sanitized.startCol,
  };
  session.indicatorAnchor = {
    bufnr: sanitized.bufnr,
    row: sanitized.startRow,
  };
  return sanitized;
}

async function cleanupSession(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  sessions.delete(sessionId);
  const nextActiveId = selectNextActiveSession(sessions, sessionId);
  if (nextActiveId) {
    await focusSession(denops, nextActiveId);
    return;
  }
  activeSessionId = null;
  const config = await loadConfig(denops);
  await setPhase(denops, "idle", config);
}

async function focusSession(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  activeSessionId = sessionId;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.indicatorAnchor) {
    setIndicatorAnchor(session.indicatorAnchor);
  }
  await setPhase(denops, toIndicatorPhase(session.phase), session.config);
}

async function updateSessionPhase(
  denops: Denops,
  sessionId: SessionId,
  phase: StatusPhase,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.phase = phase;
  if (session.indicatorAnchor) {
    // keep anchor in sync when sanitized values shift
    setIndicatorAnchor(session.indicatorAnchor);
  }
  if (isLatestSession(activeSessionId, sessionId)) {
    await setPhase(denops, toIndicatorPhase(phase), session.config);
  }
}

function getActiveSession(): SessionContext | null {
  if (!activeSessionId) {
    return null;
  }
  return sessions.get(activeSessionId) ?? null;
}

function getRecordingSession(): SessionContext | null {
  for (const session of sessions.values()) {
    if (session.phase === "recording") {
      return session;
    }
  }
  return null;
}

function getCancelableSession(): SessionContext | null {
  const active = getActiveSession();
  if (active && isCancelablePhase(active.phase)) {
    return active;
  }
  for (const session of sessions.values()) {
    if (isCancelablePhase(session.phase)) {
      return session;
    }
  }
  return null;
}

function isCancelablePhase(phase: StatusPhase): boolean {
  return phase === "recording" || phase === "stt" || phase === "gen";
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
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
    signal?: AbortSignal;
  },
): Promise<string> {
  switch (mode) {
    case "server":
      return await transcribeServer(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onPartial: options.onPartial,
        onStatus: options.onStatus,
        signal: options.signal,
      });
    case "progressive":
      return await transcribeProgressive(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onPartial: options.onPartial,
        onStatus: options.onStatus,
        signal: options.signal,
      });
    case "off":
      return await transcribeBatch(wav, {
        apiKey: options.apiKey,
        config: options.config,
        onStatus: options.onStatus,
        signal: options.signal,
      });
    case "auto":
    default:
      try {
        return await transcribeServer(wav, {
          apiKey: options.apiKey,
          config: options.config,
          onPartial: options.onPartial,
          onStatus: options.onStatus,
          signal: options.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
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
          signal: options.signal,
        });
      }
  }
}
