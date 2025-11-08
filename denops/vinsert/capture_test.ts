import { assert, assertEquals } from "./deps/assert.ts";
import { createSessionContext } from "./session.ts";
import type { RuntimeConfig } from "./config.ts";
import {
  createLastCaptureRecord,
  restoreSessionStateFromCapture,
} from "./capture.ts";

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

Deno.test("createLastCaptureRecord clones session state", () => {
  const session = createSessionContext("id", "insert", stubConfig());
  session.insertAnchor = { bufnr: 1, row: 2, col: 3 };
  session.indicatorAnchor = { bufnr: 1, row: 2 };
  session.resolvedText = "result";
  session.reservation = {
    bufnr: 1,
    startRow: 2,
    startCol: 3,
    endRow: 2,
    endCol: 3,
  };
  const wav = new Uint8Array([1, 2, 3]);
  const capture = createLastCaptureRecord(session, "transcript", wav);

  assertEquals(capture.result.resolvedText, "result");
  assertEquals(capture.result.transcript, "transcript");
  if (!capture.wav) {
    throw new Error("wav should not be null for single-segment capture");
  }
  assertEquals(Array.from(capture.wav), [1, 2, 3]);
  // Mutate original session to ensure capture keeps previous values.
  session.resolvedText = "mutated";
  if (session.reservation) {
    session.reservation.startRow = 99;
  }
  if (session.insertAnchor) {
    session.insertAnchor.row = 99;
  }
  assertEquals(capture.session.reservation?.startRow, 2);
  assertEquals(capture.session.insertAnchor?.row, 2);
  assertEquals(capture.session.mode, "insert");
  assert(
    capture.session.config !== session.config,
    "config should be cloned",
  );
});

Deno.test("restoreSessionStateFromCapture assigns captured values", () => {
  const session = createSessionContext("id", "insert", stubConfig());
  const captureSession = createSessionContext("id2", "scratch", stubConfig());
  captureSession.insertAnchor = { bufnr: 10, row: 5, col: 0 };
  captureSession.indicatorAnchor = { bufnr: 10, row: 5 };
  captureSession.reservation = null;
  const capture = createLastCaptureRecord(
    captureSession,
    "transcript",
    new Uint8Array(),
  );

  restoreSessionStateFromCapture(session, capture);

  assertEquals(session.mode, "scratch");
  assertEquals(session.insertAnchor?.bufnr, 10);
  assertEquals(session.indicatorAnchor?.row, 5);
  assertEquals(session.reservation, null);
});
