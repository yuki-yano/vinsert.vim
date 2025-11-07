import type { Denops } from "./deps/denops.ts";
import type { StatusPhase } from "./status.ts";
import type { IndicatorPhase } from "./indicator.ts";
import type { IndicatorAnchor, SessionContext } from "./session.ts";
import type { RuntimeConfig } from "./config.ts";

export type SessionId = string;

export type SessionRegistry = {
  sessions: Map<SessionId, SessionContext>;
  activeSessionId: SessionId | null;
};

export function createSessionRegistry(): SessionRegistry {
  return {
    sessions: new Map<SessionId, SessionContext>(),
    activeSessionId: null,
  };
}

export function getActiveSession(
  registry: SessionRegistry,
): SessionContext | null {
  if (!registry.activeSessionId) {
    return null;
  }
  return registry.sessions.get(registry.activeSessionId) ?? null;
}

export function getRecordingSession(
  registry: SessionRegistry,
): SessionContext | null {
  for (const session of registry.sessions.values()) {
    if (session.phase === "recording") {
      return session;
    }
  }
  return null;
}

export function getCancelableSession(
  registry: SessionRegistry,
  isCancelablePhase: (phase: StatusPhase) => boolean,
): SessionContext | null {
  const active = getActiveSession(registry);
  if (active && isCancelablePhase(active.phase)) {
    return active;
  }
  for (const session of registry.sessions.values()) {
    if (isCancelablePhase(session.phase)) {
      return session;
    }
  }
  return null;
}

export async function focusSession(
  denops: Denops,
  registry: SessionRegistry,
  sessionId: SessionId,
  deps: {
    syncSessionAnchors: (
      denops: Denops,
      session: SessionContext,
    ) => Promise<void>;
    setIndicatorAnchor: (anchor: IndicatorAnchor) => void;
    setPhase: (
      denops: Denops,
      phase: IndicatorPhase,
      config: RuntimeConfig,
      options?: { segmentIndex?: number; label?: string },
    ) => Promise<void>;
    toIndicatorPhase: (phase: StatusPhase) => IndicatorPhase;
  },
): Promise<void> {
  registry.activeSessionId = sessionId;
  const session = registry.sessions.get(sessionId);
  if (!session) {
    return;
  }
  await deps.syncSessionAnchors(denops, session);
  if (session.indicatorAnchor) {
    deps.setIndicatorAnchor(session.indicatorAnchor);
  }
  await deps.setPhase(
    denops,
    deps.toIndicatorPhase(session.phase),
    session.config,
    {
      segmentIndex: session.segmentIndex,
      label: session.segmentLabel ?? undefined,
    },
  );
}
