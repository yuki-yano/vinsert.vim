import { type Denops, fn, helper, nvimFn, variable } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";
import { loadConfig } from "./config.ts";
import { startRecording, stopRecording } from "./recorder.ts";
import { insertStream, sanitizeReservation } from "./buffer.ts";
import { appendScratch } from "./scratch.ts";
import {
  getIndicatorAnchor,
  refreshIndicator,
  setIndicatorAnchor,
  setPhase,
} from "./indicator.ts";
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
import {
  cloneRuntimeConfig,
  LastCapture,
  restoreSessionStateFromCapture,
} from "./capture.ts";
import { type PipelineDeps, runSessionPipeline } from "./pipeline.ts";
import {
  createSessionRegistry,
  focusSession as focusSessionRegistry,
  getActiveSession as registryGetActiveSession,
  getCancelableSession as registryGetCancelableSession,
  getRecordingSession as registryGetRecordingSession,
} from "./session_manager.ts";
import {
  ensureReservationNamespace,
  initializeSessionReservationMark,
  syncSessionAnchors,
} from "./reservation.ts";

type SessionId = string;

const sessionRegistry = createSessionRegistry();
type AnchorPosition = { bufnr: number; row: number; col: number };

let lastCapture: LastCapture | null = null;

const isDomException = is.InstanceOf(DOMException);
const isError = is.InstanceOf(Error);

function createPipelineDeps(): PipelineDeps {
  return {
    sessions: sessionRegistry.sessions,
    handleSessionDelta,
    syncSessionAnchors,
    updateSessionPhase,
    cleanupSession,
    setLastCapture: (capture) => {
      lastCapture = capture;
    },
  };
}

export function main(denops: Denops): void {
  denops.dispatcher = {
    async toggle(mode?: unknown): Promise<void> {
      const recording = registryGetRecordingSession(sessionRegistry);
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
      if (registryGetRecordingSession(sessionRegistry)) {
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
      const recording = registryGetRecordingSession(sessionRegistry);
      if (!recording) {
        await logWarn(denops, "[vinsert] Recording is not active.");
        return;
      }
      await logInfo(denops, "[vinsert] stop: finish recording");
      await finishRecording(denops, recording.id);
    },
    async status(): Promise<void> {
      const active = registryGetActiveSession(sessionRegistry);
      const phase = active?.phase ?? "idle";
      const mode = active?.mode ?? "insert";
      const id = active?.id ?? "-";
      await helper.echo(
        denops,
        `[vinsert] phase=${phase} mode=${mode} session=${id}`,
      );
    },
    status_info(): Record<string, unknown> {
      const active = registryGetActiveSession(sessionRegistry);
      return buildStatusSnapshot(
        active?.phase ?? "idle",
        active?.mode ?? "insert",
      );
    },
    async refresh_indicator(): Promise<void> {
      const active = registryGetActiveSession(sessionRegistry);
      if (!active) {
        return;
      }
      await syncSessionAnchors(denops, active);
      if (!active.indicatorAnchor) {
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
      const target = registryGetCancelableSession(
        sessionRegistry,
        isCancelablePhase,
      );
      if (!target) {
        await logWarn(denops, "[vinsert] No session in progress.");
        return;
      }
      await cancelRecording(denops, target.id);
    },
    async retry(): Promise<void> {
      if (registryGetRecordingSession(sessionRegistry)) {
        await logWarn(
          denops,
          "[vinsert] Recording is already in progress.",
        );
        return;
      }
      const capture = lastCapture;
      if (!capture) {
        await logWarn(
          denops,
          "[vinsert] No previous audio capture is available.",
        );
        return;
      }
      const sessionId = generateSessionId();
      const session = createSessionContext(
        sessionId,
        capture.session.mode,
        cloneRuntimeConfig(capture.session.config),
      );
      sessionRegistry.sessions.set(sessionId, session);
      if (session.mode === "insert") {
        const anchor = await createInsertAnchor(denops);
        session.insertAnchor = anchor;
        session.indicatorAnchor = {
          bufnr: anchor.bufnr,
          row: anchor.row,
        };
        session.reservation = null;
        session.reservationMarkId = null;
      } else {
        restoreSessionStateFromCapture(session, capture);
      }
      session.resolvedText = "";
      session.scratchHandle = null;
      try {
        await focusSessionWithDeps(denops, sessionId);
      } catch {
        // ignore focus errors before retrying
      }
      const apiKey = await resolveApiKey(denops);
      try {
        await runSessionPipeline(
          denops,
          sessionId,
          session,
          capture.wav.slice(),
          apiKey,
          "retry",
          createPipelineDeps(),
        );
      } catch (error) {
        await handlePipelineError(
          denops,
          sessionId,
          session,
          error,
          "retry",
        );
      }
    },
  };
}

async function beginRecording(denops: Denops, rawMode: unknown): Promise<void> {
  const config = await loadConfig(denops);
  const mode = toMode(rawMode);
  const sessionId = generateSessionId();
  const session = createSessionContext(sessionId, mode, config);
  sessionRegistry.sessions.set(sessionId, session);
  try {
    await logInfo(
      denops,
      `[vinsert] beginRecording: session=${sessionId} mode=${mode}`,
    );
    const anchor = await createInsertAnchor(denops);
    session.insertAnchor = anchor;
    session.indicatorAnchor = { bufnr: anchor.bufnr, row: anchor.row };
    await initializeSessionReservationMark(denops, session);
    await focusSessionWithDeps(denops, sessionId);
    session.recorder = await startRecording(denops, config);
    session.resolvedText = "";
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
  const session = sessionRegistry.sessions.get(sessionId);
  if (!session) {
    return;
  }
  const apiKey = await resolveApiKey(denops);
  try {
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
    await runSessionPipeline(
      denops,
      sessionId,
      session,
      wav,
      apiKey,
      "finishRecording",
      createPipelineDeps(),
    );
  } catch (error) {
    await handlePipelineError(
      denops,
      sessionId,
      session,
      error,
      "finishRecording",
    );
  }
}

async function handlePipelineError(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  error: unknown,
  source: "finishRecording" | "retry",
): Promise<void> {
  session.sttController = null;
  session.genController = null;
  if (session.canceled || isAbortError(error)) {
    return;
  }
  const context = sessionRegistry.sessions.get(sessionId);
  if (context) {
    await updateSessionPhase(denops, sessionId, "error");
  }
  await logError(
    denops,
    `[vinsert] ${source}: error`,
    error,
  );
  const target = context ?? session;
  await emitCompletionEvent(
    denops,
    target.mode,
    false,
    context?.resolvedText ?? session.resolvedText,
    "",
  );
  await cleanupSession(denops, sessionId);
}

async function cancelRecording(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  const session = sessionRegistry.sessions.get(sessionId);
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
  const session = sessionRegistry.sessions.get(sessionId);
  if (!session || session.canceled) return;
  if (session.mode === "insert" && session.reservation) {
    await syncSessionAnchors(denops, session);
    if (!session.reservation) {
      return;
    }
    await insertStream(denops, session.reservation, delta, { append: true });
  } else if (session.mode === "scratch" && session.scratchHandle) {
    await appendScratch(denops, session.scratchHandle, delta);
  }
}

function toMode(value: unknown): StatusMode {
  if (!is.String(value) || value.length === 0) {
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
  if (is.String(vimKey) && vimKey.length > 0) {
    return vimKey;
  }
  throw new Error(
    "OpenAI API key is not set. Configure the OPENAI_API_KEY environment variable or g:vinsert_openai_api_key.",
  );
}

async function createInsertAnchor(denops: Denops): Promise<AnchorPosition> {
  const bufnr = ensure(await fn.bufnr(denops, "%"), is.Number);
  const pos = ensure(await fn.getpos(denops, "."), is.ArrayOf(is.Number));
  const startRow = Math.max((pos[1] ?? 1) - 1, 0);
  const startCol = Math.max((pos[2] ?? 1) - 1, 0);
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

async function cleanupSession(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  const session = sessionRegistry.sessions.get(sessionId);
  sessionRegistry.sessions.delete(sessionId);
  if (sessionRegistry.activeSessionId === sessionId) {
    sessionRegistry.activeSessionId = null;
  }
  if (session && session.reservationMarkId !== null && session.insertAnchor) {
    const ns = await ensureReservationNamespace(denops);
    await nvimFn.nvim_buf_del_extmark(
      denops,
      session.insertAnchor.bufnr,
      ns,
      session.reservationMarkId,
    ).catch(() => {});
  }
  const nextActiveId = selectNextActiveSession(
    sessionRegistry.sessions,
    sessionId,
  );
  if (nextActiveId) {
    await focusSessionWithDeps(denops, nextActiveId);
    return;
  }
  sessionRegistry.activeSessionId = null;
  const config = await loadConfig(denops);
  await setPhase(denops, "idle", config);
}

async function focusSessionWithDeps(
  denops: Denops,
  sessionId: SessionId,
): Promise<void> {
  await focusSessionRegistry(denops, sessionRegistry, sessionId, {
    syncSessionAnchors,
    setIndicatorAnchor,
    setPhase,
    toIndicatorPhase,
  });
}

async function updateSessionPhase(
  denops: Denops,
  sessionId: SessionId,
  phase: StatusPhase,
): Promise<void> {
  const session = sessionRegistry.sessions.get(sessionId);
  if (!session) return;
  session.phase = phase;
  await syncSessionAnchors(denops, session);
  if (session.indicatorAnchor) {
    // keep anchor in sync when sanitized values shift
    setIndicatorAnchor(session.indicatorAnchor);
  }
  if (isLatestSession(sessionRegistry.activeSessionId, sessionId)) {
    await setPhase(denops, toIndicatorPhase(phase), session.config);
  }
}

function isCancelablePhase(phase: StatusPhase): boolean {
  return phase === "recording" || phase === "stt" || phase === "gen";
}

function isAbortError(error: unknown): boolean {
  if (isDomException(error) && error.name === "AbortError") {
    return true;
  }
  if (isError(error) && error.name === "AbortError") {
    return true;
  }
  return false;
}
