import { assert, assertEquals } from "./deps/assert.ts";
import { createSessionContext } from "./session.ts";
import type { RuntimeConfig } from "./config.ts";
import {
  createSessionRegistry,
  focusSession,
  getActiveSession,
  getCancelableSession,
  getRecordingSession,
} from "./session_manager.ts";
import type { Denops } from "./deps/denops.ts";
import type { IndicatorPhase } from "./indicator.ts";

function stubConfig(): RuntimeConfig {
  return {
    sttModel: "",
    llmModel: "",
    llmStream: false,
    llmRequestOptions: {},
    language: "ja",
    biasPrompt: "",
    systemPrompt: "",
    sttStreamingMode: "auto",
    ffmpegPath: "",
    ffmpegArgs: [],
    textStreamFlushMs: 0,
    textStreamBatchTokens: 1,
    indicatorMode: "virt",
    indicatorHighlights: {
      idle: "",
      rec: "",
      stt: "",
      gen: "",
      error: "",
    },
    keepAudio: false,
    alwaysYank: false,
    scratch: {
      split: "",
      size: 0,
      focus: false,
      filetype: "",
    },
  };
}

Deno.test("getActiveSession returns null when registry is idle", () => {
  const registry = createSessionRegistry();
  assertEquals(getActiveSession(registry), null);
});

Deno.test("getRecordingSession finds session in recording phase", () => {
  const registry = createSessionRegistry();
  const recording = createSessionContext("rec", "insert", stubConfig());
  recording.phase = "recording";
  registry.sessions.set(recording.id, recording);
  assertEquals(getRecordingSession(registry), recording);
});

Deno.test("getCancelableSession prioritises active session", () => {
  const registry = createSessionRegistry();
  const active = createSessionContext("active", "insert", stubConfig());
  active.phase = "stt";
  const other = createSessionContext("other", "insert", stubConfig());
  other.phase = "gen";
  registry.sessions.set(active.id, active);
  registry.sessions.set(other.id, other);
  registry.activeSessionId = active.id;
  const result = getCancelableSession(
    registry,
    (phase) => phase === "stt" || phase === "gen",
  );
  assertEquals(result, active);
});

Deno.test("focusSession updates registry and invokes deps", async () => {
  const registry = createSessionRegistry();
  const session = createSessionContext("focus", "insert", stubConfig());
  session.phase = "gen";
  session.indicatorAnchor = { bufnr: 1, row: 2 };
  registry.sessions.set(session.id, session);
  let synced = false;
  let anchorSet: unknown = null;
  const phaseArgs: string[] = [];
  const segmentArgs: number[] = [];
  await focusSession(
    {} as Denops,
    registry,
    session.id,
    {
      syncSessionAnchors: async () => {
        await Promise.resolve();
        synced = true;
      },
      setIndicatorAnchor: (anchor) => {
        anchorSet = anchor;
      },
      setPhase: async (
        _denops: Denops,
        phase: IndicatorPhase,
        _config: RuntimeConfig,
        opts?: { segmentIndex?: number },
      ): Promise<void> => {
        await Promise.resolve();
        phaseArgs.push(phase);
        segmentArgs.push(opts?.segmentIndex ?? 0);
      },
      toIndicatorPhase: () => "gen",
    },
  );
  assertEquals(registry.activeSessionId, session.id);
  assert(synced);
  assertEquals(anchorSet, session.indicatorAnchor);
  assertEquals(phaseArgs, ["gen"]);
  assertEquals(segmentArgs, [1]);
});
