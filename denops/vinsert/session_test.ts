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
  if (session.id !== "test-id") {
    throw new Error("id should match the provided value");
  }
  if (session.mode !== "insert") {
    throw new Error("mode should match the provided value");
  }
  if (session.phase !== "idle") {
    throw new Error("phase should start as idle");
  }
  if (session.lastFinal !== "") {
    throw new Error("lastFinal should start empty");
  }
  if (session.startedAt <= 0) {
    throw new Error("startedAt should be positive timestamp");
  }
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
  if (next !== "second") {
    throw new Error("should pick the most recent session id");
  }
});

Deno.test("isLatestSession checks active id against session id", () => {
  if (!isLatestSession("abc", "abc")) {
    throw new Error("session should be recognised as latest");
  }
  if (isLatestSession("abc", "def")) {
    throw new Error("different session ids should not be treated as latest");
  }
});
