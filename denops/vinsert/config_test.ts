import { assertEquals } from "./deps/assert.ts";
import { normalizeIndicatorMode } from "./config.ts";

Deno.test("normalizeIndicatorMode returns fallback for unknown", () => {
  assertEquals(normalizeIndicatorMode("virt"), "virt");
  assertEquals(normalizeIndicatorMode("statusline"), "statusline");
  assertEquals(normalizeIndicatorMode("cmdline"), "cmdline");
  assertEquals(normalizeIndicatorMode("none"), "none");
  assertEquals(normalizeIndicatorMode("invalid"), "virt");
  assertEquals(normalizeIndicatorMode(undefined), "virt");
});
