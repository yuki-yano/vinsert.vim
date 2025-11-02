import { assertEquals } from "./deps/assert.ts";
import {
  buildStatusSnapshot,
  type StatusPhase,
  toIndicatorPhase,
} from "./status.ts";

Deno.test("toIndicatorPhase maps phases to indicator phases", () => {
  const cases: Array<[StatusPhase, string]> = [
    ["idle", "idle"],
    ["recording", "rec"],
    ["stt", "stt"],
    ["gen", "gen"],
    ["error", "error"],
  ];
  for (const [phase, expected] of cases) {
    assertEquals(toIndicatorPhase(phase), expected);
  }
});

Deno.test("buildStatusSnapshot exposes status flags", () => {
  const active = buildStatusSnapshot("recording", "insert");
  assertEquals(active.active, true);
  assertEquals(active.error, false);
  assertEquals(active.label, "● REC");

  const idle = buildStatusSnapshot("idle", "yank");
  assertEquals(idle.active, false);
  assertEquals(idle.error, false);
  assertEquals(idle.label, "○ IDLE");

  const failure = buildStatusSnapshot("error", "scratch");
  assertEquals(failure.active, false);
  assertEquals(failure.error, true);
  assertEquals(failure.label, "⚠ ERROR");
});
