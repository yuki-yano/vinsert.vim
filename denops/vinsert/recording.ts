import type { Denops } from "./deps/denops.ts";
import type { RuntimeConfig } from "./config.ts";
import type { StatusMode, StatusPhase } from "./status.ts";
import type { SessionContext } from "./session.ts";
import type { PipelineDeps } from "./pipeline.ts";
import type { SessionId, SessionRegistry } from "./session_manager.ts";
import { startRecording, stopRecording } from "./recorder.ts";

export type RecordingDeps = {
  sessionRegistry: SessionRegistry;
  loadConfig: (denops: Denops) => Promise<RuntimeConfig>;
  toMode: (value: unknown) => StatusMode;
  createSessionContext: (
    id: SessionId,
    mode: StatusMode,
    config: RuntimeConfig,
  ) => SessionContext;
  generateSessionId: () => SessionId;
  createInsertAnchor: (
    denops: Denops,
  ) => Promise<{ bufnr: number; row: number; col: number }>;
  initializeSessionReservationMark: (
    denops: Denops,
    session: SessionContext,
  ) => Promise<void>;
  focusSession: (denops: Denops, sessionId: SessionId) => Promise<void>;
  updateSessionPhase: (
    denops: Denops,
    sessionId: SessionId,
    phase: StatusPhase,
  ) => Promise<void>;
  cleanupSession: (denops: Denops, sessionId: SessionId) => Promise<void>;
  runSessionPipeline: (
    denops: Denops,
    sessionId: SessionId,
    session: SessionContext,
    wav: Uint8Array,
    apiKey: string,
    source: "finishRecording" | "retry",
    deps: PipelineDeps,
  ) => Promise<void>;
  createPipelineDeps: () => PipelineDeps;
  resolveApiKey: (denops: Denops) => Promise<string>;
  logInfo: typeof import("./logger.ts").logInfo;
  logError: typeof import("./logger.ts").logError;
  logWarn: typeof import("./logger.ts").logWarn;
  emitCompletionEvent: (
    denops: Denops,
    mode: StatusMode,
    success: boolean,
    transcript: string,
    resolvedText: string,
  ) => Promise<void>;
  isAbortError: (error: unknown) => boolean;
};

export type RecordingController = {
  beginRecording: (denops: Denops, rawMode: unknown) => Promise<void>;
  finishRecording: (denops: Denops, sessionId: SessionId) => Promise<void>;
  cancelRecording: (denops: Denops, sessionId: SessionId) => Promise<void>;
  handlePipelineError: (
    denops: Denops,
    sessionId: SessionId,
    session: SessionContext,
    error: unknown,
    source: "finishRecording" | "retry",
  ) => Promise<void>;
};

export function createRecordingController(
  deps: RecordingDeps,
): RecordingController {
  async function beginRecording(
    denops: Denops,
    rawMode: unknown,
  ): Promise<void> {
    const config = await deps.loadConfig(denops);
    const mode = deps.toMode(rawMode);
    const sessionId = deps.generateSessionId();
    const session = deps.createSessionContext(sessionId, mode, config);
    deps.sessionRegistry.sessions.set(sessionId, session);
    try {
      await deps.logInfo(
        denops,
        `[vinsert] beginRecording: session=${sessionId} mode=${mode}`,
      );
      const anchor = await deps.createInsertAnchor(denops);
      session.insertAnchor = anchor;
      session.indicatorAnchor = { bufnr: anchor.bufnr, row: anchor.row };
      await deps.initializeSessionReservationMark(denops, session);
      await deps.focusSession(denops, sessionId);
      session.recorder = await startRecording(denops, config);
      session.resolvedText = "";
      session.reservation = null;
      session.scratchHandle = null;
      await deps.updateSessionPhase(denops, sessionId, "recording");
      await deps.logInfo(denops, "[vinsert] Recording started.");
    } catch (error) {
      await deps.updateSessionPhase(denops, sessionId, "error");
      await deps.logError(denops, "[vinsert] beginRecording: failed", error);
      await deps.cleanupSession(denops, sessionId);
    }
  }

  async function finishRecording(
    denops: Denops,
    sessionId: SessionId,
  ): Promise<void> {
    const session = deps.sessionRegistry.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const apiKey = await deps.resolveApiKey(denops);
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
      await deps.logInfo(
        denops,
        `[vinsert] finishRecording: wav size=${wav.length} bytes`,
      );
      await deps.runSessionPipeline(
        denops,
        sessionId,
        session,
        wav,
        apiKey,
        "finishRecording",
        deps.createPipelineDeps(),
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
    if (session.canceled || deps.isAbortError(error)) {
      return;
    }
    const context = deps.sessionRegistry.sessions.get(sessionId);
    if (context) {
      await deps.updateSessionPhase(denops, sessionId, "error");
    }
    await deps.logError(
      denops,
      `[vinsert] ${source}: error`,
      error,
    );
    const target = context ?? session;
    await deps.emitCompletionEvent(
      denops,
      target.mode,
      false,
      context?.resolvedText ?? session.resolvedText,
      "",
    );
    await deps.cleanupSession(denops, sessionId);
  }

  async function cancelRecording(
    denops: Denops,
    sessionId: SessionId,
  ): Promise<void> {
    const session = deps.sessionRegistry.sessions.get(sessionId);
    if (!session) {
      await deps.logWarn(denops, "[vinsert] Recording is not active.");
      return;
    }
    await deps.logInfo(
      denops,
      `[vinsert] cancelRecording: aborting session=${sessionId}`,
    );
    try {
      if (session.recorder) {
        await stopRecording(denops, session.recorder, session.config.keepAudio);
      }
    } catch (error) {
      await deps.logError(
        denops,
        "[vinsert] cancelRecording: stop failed",
        error,
      );
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
      await deps.updateSessionPhase(denops, sessionId, "idle");
      await deps.emitCompletionEvent(denops, session.mode, false, "", "");
      await deps.cleanupSession(denops, sessionId);
      await deps.logInfo(denops, "[vinsert] Recording canceled.");
    }
  }

  return {
    beginRecording,
    finishRecording,
    cancelRecording,
    handlePipelineError,
  };
}
