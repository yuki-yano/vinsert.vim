import type { Denops } from "./deps/denops.ts";
import type { RuntimeConfig } from "./config.ts";
import type { StatusMode, StatusPhase } from "./status.ts";
import type { SegmentRecord, SessionContext } from "./session.ts";
import type { PipelineDeps } from "./pipeline.ts";
import type { SessionId, SessionRegistry } from "./session_manager.ts";
import {
  deleteRecordingFile,
  startRecording,
  stopRecording,
} from "./recorder.ts";
import { is } from "./deps/unknownutil.ts";

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
  nextSegment: (denops: Denops, sessionId: SessionId) => Promise<void>;
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
      await startRecorder(denops, session);
      session.resolvedText = "";
      session.reservation = null;
      session.scratchHandle = null;
      session.segments = [];
      session.segmentIndex = 1;
      session.segmentLabel = await resolveSegmentLabel(
        denops,
        session.segmentIndex,
      );
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
    let removeFiles = !session.config.keepAudio;
    try {
      if (!session.recorder && session.segments.length === 0) {
        throw new Error("No recording in progress.");
      }
      if (session.recorder) {
        await finalizeActiveRecording(denops, session, {
          continueRecording: false,
        });
      }
      await deps.logInfo(
        denops,
        `[vinsert] finishRecording: segments=${session.segments.length}`,
      );
      await deps.runSessionPipeline(
        denops,
        sessionId,
        session,
        apiKey,
        "finishRecording",
        deps.createPipelineDeps(),
      );
    } catch (error) {
      removeFiles = true;
      await handlePipelineError(
        denops,
        sessionId,
        session,
        error,
        "finishRecording",
      );
      return;
    } finally {
      await cleanupSegments(denops, session, removeFiles);
    }
  }

  async function nextSegment(
    denops: Denops,
    sessionId: SessionId,
  ): Promise<void> {
    const session = deps.sessionRegistry.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.phase !== "recording" || !session.recorder) {
      await deps.logWarn(
        denops,
        "[vinsert] nextSegment: recording is not active.",
      );
      return;
    }
    try {
      await finalizeActiveRecording(denops, session, {
        continueRecording: true,
      });
      await deps.updateSessionPhase(denops, sessionId, "recording");
      await deps.logInfo(
        denops,
        `[vinsert] nextSegment: segments=${session.segments.length}`,
      );
    } catch (error) {
      await deps.logError(denops, "[vinsert] nextSegment: failed", error);
      await deps.updateSessionPhase(denops, sessionId, "error");
      await cleanupSegments(denops, session, true);
      await deps.cleanupSession(denops, sessionId);
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
        const result = await stopRecording(denops, session.recorder);
        await deleteRecordingFile(result.filepath);
        session.recorder = null;
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
      await cleanupSegments(denops, session, true);
      await deps.updateSessionPhase(denops, sessionId, "idle");
      await deps.emitCompletionEvent(denops, session.mode, false, "", "");
      await deps.cleanupSession(denops, sessionId);
      await deps.logInfo(denops, "[vinsert] Recording canceled.");
    }
  }

  async function finalizeActiveRecording(
    denops: Denops,
    session: SessionContext,
    options: { continueRecording: boolean },
  ): Promise<void> {
    const segment = await captureSegment(denops, session);
    session.segments.push(segment);
    session.segmentIndex = session.segments.length;
    if (options.continueRecording) {
      await startRecorder(denops, session);
      session.segmentIndex = session.segments.length + 1;
      session.segmentLabel = await resolveSegmentLabel(
        denops,
        session.segmentIndex,
      );
    } else {
      session.segmentLabel = null;
    }
  }

  async function captureSegment(
    denops: Denops,
    session: SessionContext,
  ): Promise<SegmentRecord> {
    if (!session.recorder) {
      throw new Error("Recorder handle is missing.");
    }
    const result = await stopRecording(denops, session.recorder);
    session.recorder = null;
    await deps.logInfo(
      denops,
      `[vinsert] segment captured: bytes=${result.audioData.length}`,
    );
    return {
      id: crypto.randomUUID(),
      audioPath: result.filepath,
      audioData: result.audioData,
      transcript: null,
      promptText: null,
    };
  }

  async function startRecorder(
    denops: Denops,
    session: SessionContext,
  ): Promise<void> {
    session.recorder = await startRecording(denops, session.config);
  }

  async function cleanupSegments(
    denops: Denops,
    session: SessionContext,
    removeFiles: boolean,
  ): Promise<void> {
    if (removeFiles) {
      await Promise.allSettled(
        session.segments.map(async (segment) => {
          if (segment.audioPath) {
            await deleteRecordingFile(segment.audioPath);
          }
        }),
      );
    } else {
      for (const segment of session.segments) {
        if (segment.audioPath) {
          await deps.logInfo(
            denops,
            `[vinsert] audio kept at ${segment.audioPath}`,
          ).catch(() => {});
        }
      }
    }
    session.segments = [];
    session.segmentIndex = 1;
    session.segmentLabel = null;
  }

  async function resolveSegmentLabel(
    denops: Denops,
    segmentIndex: number,
  ): Promise<string | null> {
    try {
      const raw = await denops.call(
        "vinsert#prompt_segment_label",
        Math.max(segmentIndex - 1, 0),
      );
      if (is.String(raw) && raw.length > 0) {
        return raw;
      }
    } catch {
      // ignore label resolution errors
    }
    return null;
  }

  return {
    beginRecording,
    finishRecording,
    nextSegment,
    cancelRecording,
    handlePipelineError,
  };
}
