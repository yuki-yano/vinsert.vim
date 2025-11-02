import { assertEquals } from "./deps/assert.ts";
import {
  DEFAULT_INDICATOR_HIGHLIGHTS,
  type IndicatorHighlights,
  normalizeHighlights,
  normalizeIndicatorMode,
} from "./config.ts";

Deno.test("normalizeIndicatorMode returns fallback for unknown", () => {
  assertEquals(normalizeIndicatorMode("virt"), "virt");
  assertEquals(normalizeIndicatorMode("statusline"), "statusline");
  assertEquals(normalizeIndicatorMode("cmdline"), "cmdline");
  assertEquals(normalizeIndicatorMode("none"), "none");
  assertEquals(normalizeIndicatorMode("invalid"), "virt");
  assertEquals(normalizeIndicatorMode(undefined), "virt");
});

Deno.test("normalizeHighlights merges overrides and falls back to defaults", () => {
  const overrides = { rec: "Title", extra: "Ignored" };
  const normalized = normalizeHighlights(overrides);
  const expected: IndicatorHighlights = {
    ...DEFAULT_INDICATOR_HIGHLIGHTS,
    rec: "Title",
  };
  assertEquals(normalized, expected);
});
