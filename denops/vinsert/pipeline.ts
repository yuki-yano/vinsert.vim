import { prepareScratch, replaceScratch } from "./scratch.ts";
import {
  finalizeUndo,
  type InsertReservation,
  insertStream,
} from "./buffer.ts";
import {
  transcribeBatch,
  transcribeProgressive,
  transcribeServer,
} from "./stt.ts";
import { streamGenerate } from "./llm.ts";
import { yankToRegister } from "./yank.ts";
import { emitCompletionEvent } from "./events.ts";
import { logError, logInfo } from "./logger.ts";
import type { Denops } from "./deps/denops.ts";
import type { SessionContext } from "./session.ts";
import type { LastCapture } from "./capture.ts";
import { createLastCaptureRecord } from "./capture.ts";
import type { StatusPhase } from "./status.ts";

export type SessionId = string;

export type PipelineDeps = {
  sessions: Map<SessionId, SessionContext>;
  handleSessionDelta: (
    denops: Denops,
    sessionId: SessionId,
    delta: string,
  ) => Promise<void>;
  syncSessionAnchors: (
    denops: Denops,
    session: SessionContext,
  ) => Promise<void>;
  updateSessionPhase: (
    denops: Denops,
    sessionId: SessionId,
    phase: StatusPhase,
  ) => Promise<void>;
  cleanupSession: (denops: Denops, sessionId: SessionId) => Promise<void>;
  ensureSessionInsertReservation: (
    denops: Denops,
    session: SessionContext,
  ) => Promise<InsertReservation>;
  setLastCapture: (capture: LastCapture) => void;
};

const APPROX_BYTES_PER_TOKEN = 4;

export async function runSessionPipeline(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  wav: Uint8Array,
  apiKey: string,
  source: "finishRecording" | "retry",
  deps: PipelineDeps,
): Promise<void> {
  const label = source === "retry" ? "retry" : "finishRecording";
  await logInfo(
    denops,
    `[vinsert] ${label}: session=${sessionId} entering STT phase`,
  );
  session.resolvedText = "";
  await deps.updateSessionPhase(denops, sessionId, "stt");
  await prepareSessionForPipeline(denops, session, deps);

  const transcript = await executeSttPhase(
    denops,
    sessionId,
    session,
    wav,
    apiKey,
    deps,
  );
  const current = deps.sessions.get(sessionId);
  if (!current || current.canceled) {
    return;
  }

  await logInfo(
    denops,
    `[vinsert] STT completed: length=${transcript.length}`,
  );
  await deps.updateSessionPhase(denops, sessionId, "gen");
  await executeGenerationPhase(
    denops,
    sessionId,
    current,
    transcript,
    apiKey,
    deps,
  );

  const latest = deps.sessions.get(sessionId);
  if (!latest || latest.canceled) {
    return;
  }
  await latest.flushPromise;
  await finalizeSessionRun(
    denops,
    sessionId,
    latest,
    transcript,
    wav,
    deps,
  );
}

async function prepareSessionForPipeline(
  denops: Denops,
  session: SessionContext,
  deps: PipelineDeps,
): Promise<void> {
  if (session.mode === "insert") {
    session.reservation = await deps.ensureSessionInsertReservation(
      denops,
      session,
    );
    return;
  }
  if (session.mode === "scratch") {
    session.scratchHandle = await prepareScratch(denops, session.config);
  }
}

async function executeSttPhase(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  wav: Uint8Array,
  apiKey: string,
  deps: PipelineDeps,
): Promise<string> {
  const onPartial = createSttPartialHandler(denops, sessionId, deps);
  session.sttController = new AbortController();
  const sttSignal = session.sttController.signal;
  try {
    return await transcribeByMode(
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
}

function createSttPartialHandler(
  denops: Denops,
  sessionId: SessionId,
  deps: PipelineDeps,
): (text: string) => void {
  return (text: string) => {
    logInfo(
      denops,
      `[vinsert] STT partial length=${text.length} session=${sessionId}`,
    ).catch(() => {});
    const current = deps.sessions.get(sessionId);
    if (!current || current.canceled) {
      return;
    }
    if (current.mode === "insert" && current.reservation) {
      Promise.resolve()
        .then(async () => {
          await deps.syncSessionAnchors(denops, current);
          if (!current.reservation) {
            return;
          }
          await insertStream(
            denops,
            current.reservation,
            text,
            { replace: true },
          );
        })
        .catch(() => {});
    }
    if (current.mode === "scratch" && current.scratchHandle) {
      replaceScratch(denops, current.scratchHandle, text).catch(() => {});
    }
  };
}

async function executeGenerationPhase(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  transcript: string,
  apiKey: string,
  deps: PipelineDeps,
): Promise<void> {
  let batch = "";
  const threshold = Math.max(session.config.textStreamBatchTokens, 1) *
    APPROX_BYTES_PER_TOKEN;
  const flush = (content: string): void => {
    if (!content) {
      return;
    }
    const pending = deps.sessions.get(sessionId);
    if (!pending) {
      return;
    }
    pending.flushPromise = pending.flushPromise.then(() =>
      deps.handleSessionDelta(denops, sessionId, content)
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
        const currentSession = deps.sessions.get(sessionId);
        if (!currentSession || currentSession.canceled) {
          return;
        }
        batch += delta;
        currentSession.resolvedText += delta;
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
  const latest = deps.sessions.get(sessionId);
  if (!latest || latest.canceled) {
    return;
  }
  await latest.flushPromise;
  if (batch.length > 0) {
    await deps.handleSessionDelta(denops, sessionId, batch);
  }
}

async function finalizeSessionRun(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  transcript: string,
  wav: Uint8Array,
  deps: PipelineDeps,
): Promise<void> {
  const shouldYank = session.mode === "yank" || session.config.alwaysYank;
  if (shouldYank) {
    await yankToRegister(denops, session.resolvedText, '"');
  }
  if (session.mode === "insert" && session.reservation) {
    await finalizeUndo(denops, session.reservation.bufnr);
  }
  deps.setLastCapture(createLastCaptureRecord(session, transcript, wav));
  await logInfo(denops, "[vinsert] Generation finished.");
  await emitCompletionEvent(
    denops,
    session.mode,
    true,
    transcript,
    session.resolvedText,
  );
  await deps.updateSessionPhase(denops, sessionId, "idle");
  await deps.cleanupSession(denops, sessionId);
}

async function transcribeByMode(
  denops: Denops,
  mode: SessionContext["config"]["sttStreamingMode"],
  wav: Uint8Array,
  options: {
    apiKey: string;
    config: SessionContext["config"];
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}
