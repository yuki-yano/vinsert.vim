import { type Denops, fn, helper, nvimFn, variable } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";
import { loadConfig } from "./config.ts";
import { startRecording, stopRecording } from "./recorder.ts";
import {
  type InsertReservation,
  insertStream,
  reserveInsertRange,
  sanitizeReservation,
} from "./buffer.ts";
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

type SessionId = string;

let reservationNamespace: number | null = null;

const sessions = new Map<SessionId, SessionContext>();
let activeSessionId: SessionId | null = null;
type AnchorPosition = { bufnr: number; row: number; col: number };

let lastCapture: LastCapture | null = null;

const isDomException = is.InstanceOf(DOMException);
const isError = is.InstanceOf(Error);

function createPipelineDeps(): PipelineDeps {
  return {
    sessions,
    handleSessionDelta,
    syncSessionAnchors,
    updateSessionPhase,
    cleanupSession,
    ensureSessionInsertReservation,
    setLastCapture: (capture) => {
      lastCapture = capture;
    },
  };
}

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
      const target = getCancelableSession();
      if (!target) {
        await logWarn(denops, "[vinsert] No session in progress.");
        return;
      }
      await cancelRecording(denops, target.id);
    },
    async retry(): Promise<void> {
      if (getRecordingSession()) {
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
      sessions.set(sessionId, session);
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
        await focusSession(denops, sessionId);
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
  sessions.set(sessionId, session);
  try {
    await logInfo(
      denops,
      `[vinsert] beginRecording: session=${sessionId} mode=${mode}`,
    );
    const anchor = await createInsertAnchor(denops);
    session.insertAnchor = anchor;
    session.indicatorAnchor = { bufnr: anchor.bufnr, row: anchor.row };
    await initializeSessionReservationMark(denops, session);
    await focusSession(denops, sessionId);
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
  const session = sessions.get(sessionId);
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
  const context = sessions.get(sessionId);
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

async function ensureReservationNamespace(denops: Denops): Promise<number> {
  if (reservationNamespace !== null) {
    return reservationNamespace;
  }
  reservationNamespace = ensure(
    await nvimFn.nvim_create_namespace(denops, "vinsert.session"),
    is.Number,
  );
  return reservationNamespace;
}

async function syncSessionAnchors(
  denops: Denops,
  session: SessionContext,
): Promise<void> {
  if (!session.insertAnchor || session.reservationMarkId === null) {
    return;
  }
  const ns = await ensureReservationNamespace(denops);
  try {
    const position = ensure(
      await nvimFn.nvim_buf_get_extmark_by_id(
        denops,
        session.insertAnchor.bufnr,
        ns,
        session.reservationMarkId,
        {},
      ),
      is.ArrayOf(is.Number),
    );
    if (position.length < 2) {
      return;
    }
    const [markRow, markCol] = position;
    const previous = session.insertAnchor;
    if (markRow === previous.row && markCol === previous.col) {
      return;
    }
    const rowDiff = markRow - previous.row;
    const colDiff = markCol - previous.col;
    session.insertAnchor = {
      bufnr: previous.bufnr,
      row: markRow,
      col: markCol,
    };
    session.indicatorAnchor = {
      bufnr: previous.bufnr,
      row: markRow,
    };
    if (session.reservation) {
      const updatedReservation = {
        ...session.reservation,
        startRow: markRow,
        startCol: markCol,
        endRow: session.reservation.endRow + rowDiff,
        endCol: session.reservation.endCol +
          (rowDiff === 0 ? colDiff : 0),
      };
      const sanitized = await sanitizeReservation(
        denops,
        updatedReservation,
        false,
      );
      Object.assign(session.reservation, sanitized);
    }
  } catch {
    // ignore extmark lookup failures
  }
}

async function initializeSessionReservationMark(
  denops: Denops,
  session: SessionContext,
): Promise<void> {
  if (!session.insertAnchor) {
    return;
  }
  const ns = await ensureReservationNamespace(denops);
  const options: Record<string, unknown> = {
    right_gravity: true,
  };
  if (session.reservationMarkId !== null) {
    options.id = session.reservationMarkId;
  }
  session.reservationMarkId = ensure(
    await nvimFn.nvim_buf_set_extmark(
      denops,
      session.insertAnchor.bufnr,
      ns,
      session.insertAnchor.row,
      session.insertAnchor.col,
      options,
    ),
    is.Number,
  );
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
    await initializeSessionReservationMark(denops, session);
    return fallback;
  }
  await initializeSessionReservationMark(denops, session);
  const ns = await ensureReservationNamespace(denops);
  const bufnr = session.insertAnchor.bufnr;
  const isNumberArray = is.ArrayOf(is.Number);
  let rawPosition = await nvimFn.nvim_buf_get_extmark_by_id(
    denops,
    bufnr,
    ns,
    session.reservationMarkId,
    {},
  );
  let position = isNumberArray(rawPosition) ? rawPosition : [];
  if (position.length < 2) {
    session.reservationMarkId = ensure(
      await nvimFn.nvim_buf_set_extmark(
        denops,
        bufnr,
        ns,
        session.insertAnchor.row,
        session.insertAnchor.col,
        {
          right_gravity: true,
        },
      ),
      is.Number,
    );
    rawPosition = await nvimFn.nvim_buf_get_extmark_by_id(
      denops,
      bufnr,
      ns,
      session.reservationMarkId,
      {},
    );
    position = isNumberArray(rawPosition) ? rawPosition : [];
  }
  if (position.length < 2) {
    position = [session.insertAnchor.row, session.insertAnchor.col];
  }
  const [markRow, markCol] = position;
  const sanitized = await sanitizeReservation(denops, {
    bufnr,
    startRow: markRow,
    startCol: markCol,
    endRow: markRow,
    endCol: markCol,
  }, false);
  session.reservationMarkId = ensure(
    await nvimFn.nvim_buf_set_extmark(
      denops,
      bufnr,
      ns,
      sanitized.startRow,
      sanitized.startCol,
      {
        right_gravity: true,
        ...(session.reservationMarkId !== null
          ? { id: session.reservationMarkId }
          : {}),
      },
    ),
    is.Number,
  );
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
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session && session.reservationMarkId !== null && session.insertAnchor) {
    const ns = await ensureReservationNamespace(denops);
    await nvimFn.nvim_buf_del_extmark(
      denops,
      session.insertAnchor.bufnr,
      ns,
      session.reservationMarkId,
    ).catch(() => {});
  }
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
  await syncSessionAnchors(denops, session);
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
  await syncSessionAnchors(denops, session);
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
  if (isDomException(error) && error.name === "AbortError") {
    return true;
  }
  if (isError(error) && error.name === "AbortError") {
    return true;
  }
  return false;
}
