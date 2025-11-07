import { prepareScratch } from "./scratch.ts";
import { finalizeUndo } from "./buffer.ts";
import {
  transcribeBatch,
  transcribeProgressive,
  transcribeServer,
} from "./stt.ts";
import { type PromptMessage, streamGenerate } from "./llm.ts";
import { yankToRegister } from "./yank.ts";
import { emitCompletionEvent } from "./events.ts";
import { logError, logInfo, logWarn } from "./logger.ts";
import type { Denops } from "./deps/denops.ts";
import type { SessionContext } from "./session.ts";
import type { LastCapture } from "./capture.ts";
import { createLastCaptureRecord } from "./capture.ts";
import type { StatusPhase } from "./status.ts";
import { ensureSessionInsertReservation } from "./reservation.ts";
import { is } from "./deps/unknownutil.ts";

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
  setLastCapture: (capture: LastCapture) => void;
};

const APPROX_BYTES_PER_TOKEN = 4;

export async function runSessionPipeline(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  apiKey: string,
  source: "finishRecording" | "retry",
  deps: PipelineDeps,
): Promise<void> {
  const label = source === "retry" ? "retry" : "finishRecording";
  await logInfo(
    denops,
    `[vinsert] ${label}: session=${sessionId} entering STT phase`,
  );
  if (session.segments.length === 0) {
    throw new Error("No audio segments recorded.");
  }
  session.resolvedText = "";
  await deps.updateSessionPhase(denops, sessionId, "stt");
  await prepareSessionForPipeline(denops, session);

  const {
    transcripts,
    combinedTranscript,
    retryAudio,
  } = await executeSttPhase(
    denops,
    session,
    apiKey,
  );
  const current = deps.sessions.get(sessionId);
  if (!current || current.canceled) {
    return;
  }

  await logInfo(
    denops,
    `[vinsert] STT completed: segments=${transcripts.length} totalLength=${combinedTranscript.length}`,
  );
  const prompts = await applyPromptTransformers(
    denops,
    sessionId,
    current,
    transcripts,
  );
  const messages = buildMessagePayload(current.config.systemPrompt, prompts);
  await deps.updateSessionPhase(denops, sessionId, "gen");
  await executeGenerationPhase(
    denops,
    sessionId,
    current,
    messages,
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
    combinedTranscript,
    retryAudio,
    deps,
  );
}

async function prepareSessionForPipeline(
  denops: Denops,
  session: SessionContext,
): Promise<void> {
  if (session.mode === "insert") {
    session.reservation = await ensureSessionInsertReservation(
      denops,
      session,
    );
    return;
  }
  if (session.mode === "scratch") {
    session.scratchHandle = await prepareScratch(denops, session.config);
  }
}

type SttPhaseResult = {
  transcripts: string[];
  combinedTranscript: string;
  retryAudio: Uint8Array | null;
};

async function executeSttPhase(
  denops: Denops,
  session: SessionContext,
  apiKey: string,
): Promise<SttPhaseResult> {
  session.sttController = new AbortController();
  const sttSignal = session.sttController.signal;
  const retryAudio = session.segments.length === 1
    ? session.segments[0].audioData.slice()
    : null;
  try {
    const transcripts = await Promise.all(
      session.segments.map(async (segment, index) => {
        const text = await transcribeByMode(
          denops,
          session.config.sttStreamingMode,
          segment.audioData,
          {
            apiKey,
            config: session.config,
            onPartial: () => {},
            onStatus: async (message) => {
              await logInfo(
                denops,
                `[vinsert] STT segment=${index + 1}: ${message}`,
              ).catch(() => {});
            },
            signal: sttSignal,
          },
        );
        segment.transcript = text;
        segment.audioData = new Uint8Array();
        return text;
      }),
    );
    const combinedTranscript = transcripts.join("\n\n");
    return { transcripts, combinedTranscript, retryAudio };
  } finally {
    session.sttController = null;
  }
}

async function applyPromptTransformers(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  transcripts: string[],
): Promise<string[]> {
  const prompts: string[] = [];
  for (let index = 0; index < transcripts.length; index++) {
    const text = transcripts[index] ?? "";
    let prompt = text;
    try {
      const transformed = await denops.call(
        "vinsert#apply_prompt_segment_transformer",
        index,
        text,
      );
      if (is.String(transformed)) {
        prompt = transformed;
      } else {
        await logWarn(
          denops,
          `[vinsert] segment=${
            index + 1
          } transformer returned non-string (session=${sessionId})`,
        ).catch(() => {});
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await logWarn(
        denops,
        `[vinsert] segment=${index + 1} transformer error: ${detail}`,
      ).catch(() => {});
      prompt = text;
    }
    if (session.segments[index]) {
      session.segments[index].promptText = prompt;
    }
    prompts.push(prompt);
  }
  return prompts;
}

function buildMessagePayload(
  systemPrompt: string,
  prompts: string[],
): PromptMessage[] {
  const messages: PromptMessage[] = [
    { role: "developer", content: systemPrompt },
  ];
  for (const prompt of prompts) {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

async function executeGenerationPhase(
  denops: Denops,
  sessionId: SessionId,
  session: SessionContext,
  messages: PromptMessage[],
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
    await streamGenerate(messages, {
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
  retryAudio: Uint8Array | null,
  deps: PipelineDeps,
): Promise<void> {
  const shouldYank = session.mode === "yank" || session.config.alwaysYank;
  if (shouldYank) {
    await yankToRegister(denops, session.resolvedText, '"');
  }
  if (session.mode === "insert" && session.reservation) {
    await finalizeUndo(denops, session.reservation.bufnr);
  }
  const captureAudio = retryAudio && session.segments.length === 1
    ? retryAudio
    : null;
  deps.setLastCapture(
    createLastCaptureRecord(session, transcript, captureAudio),
  );
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
