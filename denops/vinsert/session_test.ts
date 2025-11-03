import { assert, assertEquals } from "./deps/assert.ts";
import {
  createSessionContext,
  isLatestSession,
  selectNextActiveSession,
} from "./session.ts";
import type { RuntimeConfig } from "./config.ts";

function stubConfig(): RuntimeConfig {
  return {
    sttModel: "",
    llmModel: "",
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

Deno.test("createSessionContext initializes defaults", () => {
  const session = createSessionContext("test-id", "insert", stubConfig());
  assertEquals(session.id, "test-id");
  assertEquals(session.mode, "insert");
  assertEquals(session.phase, "idle");
  assertEquals(session.lastFinal, "");
  assert(
    session.startedAt > 0,
    "startedAt should be positive timestamp",
  );
});

Deno.test("selectNextActiveSession picks the most recent session", () => {
  const sessions = new Map<string, ReturnType<typeof createSessionContext>>();
  const first = createSessionContext("first", "insert", stubConfig());
  const second = createSessionContext("second", "insert", stubConfig());
  // emulate order: second starts later
  second.startedAt = first.startedAt + 10;
  sessions.set(first.id, first);
  sessions.set(second.id, second);

  const next = selectNextActiveSession(sessions, "first");
  assertEquals(next, "second");
});

Deno.test("isLatestSession checks active id against session id", () => {
  assert(isLatestSession("abc", "abc"));
  assert(!isLatestSession("abc", "def"));
});
