import { assertEquals } from "./deps/assert.ts";
import { buildVirtText } from "./indicator.ts";

Deno.test("buildVirtText uses phase-specific highlight groups", () => {
  assertEquals(buildVirtText("idle", "○"), [["○", "Comment"]]);
  assertEquals(buildVirtText("rec", "●"), [["●", "DiffDelete"]]);
  assertEquals(buildVirtText("stt", "⌛"), [["⌛", "DiagnosticSignWarn"]]);
  assertEquals(buildVirtText("gen", "✎"), [["✎", "DiagnosticSignInfo"]]);
  assertEquals(buildVirtText("error", "⚠"), [["⚠", "DiagnosticSignError"]]);
});
