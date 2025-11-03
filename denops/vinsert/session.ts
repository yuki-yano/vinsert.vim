import type { InsertReservation } from "./buffer.ts";
import type { RecorderHandle } from "./recorder.ts";
import type { ScratchHandle } from "./scratch.ts";
import type { RuntimeConfig } from "./config.ts";
import type { StatusMode, StatusPhase } from "./status.ts";

export type IndicatorAnchor = { bufnr: number; row: number } | null;
export type InsertAnchor = { bufnr: number; row: number; col: number } | null;

export type SessionContext = {
  id: string;
  mode: StatusMode;
  phase: StatusPhase;
  reservation: InsertReservation | null;
  scratchHandle: ScratchHandle | null;
  lastFinal: string;
  insertAnchor: InsertAnchor;
  indicatorAnchor: IndicatorAnchor;
  recorder: RecorderHandle | null;
  sttController: AbortController | null;
  genController: AbortController | null;
  canceled: boolean;
  flushPromise: Promise<void>;
  startedAt: number;
  config: RuntimeConfig;
};

export function createSessionContext(
  id: string,
  mode: StatusMode,
  config: RuntimeConfig,
): SessionContext {
  return {
    id,
    mode,
    phase: "idle",
    reservation: null,
    scratchHandle: null,
    lastFinal: "",
    insertAnchor: null,
    indicatorAnchor: null,
    recorder: null,
    sttController: null,
    genController: null,
    canceled: false,
    flushPromise: Promise.resolve(),
    startedAt: Date.now(),
    config,
  };
}

export function isLatestSession(
  activeSessionId: string | null,
  sessionId: string,
): boolean {
  return activeSessionId === sessionId;
}

export function selectNextActiveSession(
  sessions: Map<string, SessionContext>,
  ignoreSessionId: string,
): string | null {
  let candidate: SessionContext | null = null;
  for (const session of sessions.values()) {
    if (session.id === ignoreSessionId) {
      continue;
    }
    if (candidate === null || session.startedAt > candidate.startedAt) {
      candidate = session;
    }
  }
  return candidate ? candidate.id : null;
}

export function generateSessionId(): string {
  return crypto.randomUUID();
}
