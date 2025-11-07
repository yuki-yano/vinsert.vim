import { type Denops, fn, helper, nvimFn, variable } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";
import { loadConfig } from "./config.ts";
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
  type SegmentRecord,
  selectNextActiveSession,
} from "./session.ts";
import {
  cloneRuntimeConfig,
  LastCapture,
  restoreSessionStateFromCapture,
} from "./capture.ts";
import { type PipelineDeps, runSessionPipeline } from "./pipeline.ts";
import {
  createSessionRegistry,
  focusSession,
  getActiveSession,
  getCancelableSession,
  getRecordingSession,
} from "./session_manager.ts";
import {
  ensureReservationNamespace,
  initializeSessionReservationMark,
  syncSessionAnchors,
} from "./reservation.ts";
import { createRecordingController } from "./recording.ts";

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

const recordingController = createRecordingController({
  sessionRegistry,
  loadConfig,
  toMode,
  createSessionContext,
  generateSessionId,
  createInsertAnchor,
  initializeSessionReservationMark,
  focusSession: focusSessionWithDeps,
  updateSessionPhase,
  cleanupSession,
  runSessionPipeline,
  createPipelineDeps,
  resolveApiKey,
  logInfo,
  logError,
  logWarn,
  emitCompletionEvent,
  isAbortError,
});

export function main(denops: Denops): void {
  denops.dispatcher = {
    async toggle(mode?: unknown): Promise<void> {
      const activeRecording = getRecordingSession(sessionRegistry);
      if (!activeRecording) {
        await logInfo(denops, "[vinsert] toggle: begin recording").catch(
          () => {},
        );
        await recordingController.beginRecording(denops, mode);
        return;
      }
      await logInfo(denops, "[vinsert] toggle: finish recording").catch(
        () => {},
      );
      await recordingController.finishRecording(denops, activeRecording.id);
    },
    async start(mode?: unknown): Promise<void> {
      if (
        getRecordingSession(sessionRegistry) ||
        getCancelableSession(sessionRegistry, isCancelablePhase)
      ) {
        await logWarn(
          denops,
          "[vinsert] Another session is still running.",
        );
        return;
      }
      await logInfo(denops, "[vinsert] start: begin recording");
      await recordingController.beginRecording(denops, mode);
    },
    async stop(): Promise<void> {
      const activeRecording = getRecordingSession(sessionRegistry);
      if (!activeRecording) {
        await logWarn(denops, "[vinsert] Recording is not active.");
        return;
      }
      await logInfo(denops, "[vinsert] stop: finish recording");
      await recordingController.finishRecording(denops, activeRecording.id);
    },
    async next_segment(): Promise<void> {
      const activeRecording = getRecordingSession(sessionRegistry);
      if (!activeRecording) {
        await logWarn(denops, "[vinsert] Recording is not active.");
        return;
      }
      await recordingController.nextSegment(denops, activeRecording.id);
    },
    async status(): Promise<void> {
      const active = getActiveSession(sessionRegistry);
      const phase = active?.phase ?? "idle";
      const mode = active?.mode ?? "insert";
      const id = active?.id ?? "-";
      await helper.echo(
        denops,
        `[vinsert] phase=${phase} mode=${mode} session=${id}`,
      );
    },
    status_info(): Record<string, unknown> {
      const active = getActiveSession(sessionRegistry);
      return buildStatusSnapshot(
        active?.phase ?? "idle",
        active?.mode ?? "insert",
        active?.segmentIndex ?? 1,
      );
    },
    async refresh_indicator(): Promise<void> {
      const active = getActiveSession(sessionRegistry);
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
      const target = getCancelableSession(
        sessionRegistry,
        isCancelablePhase,
      );
      if (!target) {
        await logWarn(denops, "[vinsert] No session in progress.");
        return;
      }
      await recordingController.cancelRecording(denops, target.id);
    },
    async retry(): Promise<void> {
      if (getRecordingSession(sessionRegistry)) {
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
      if (!capture.wav || capture.wav.length === 0) {
        await logWarn(
          denops,
          "[vinsert] The previous session cannot be retried.",
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
      const retrySegment: SegmentRecord = {
        id: crypto.randomUUID(),
        audioPath: "",
        audioData: capture.wav.slice(),
        transcript: null,
        promptText: null,
      };
      session.segments = [retrySegment];
      session.segmentIndex = 1;
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
          apiKey,
          "retry",
          createPipelineDeps(),
        );
      } catch (error) {
        await recordingController.handlePipelineError(
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
  await focusSession(denops, sessionRegistry, sessionId, {
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
    await setPhase(denops, toIndicatorPhase(phase), session.config, {
      segmentIndex: session.segmentIndex,
    });
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
