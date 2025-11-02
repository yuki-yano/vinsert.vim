import { assertEquals } from "./deps/assert.ts";
import {
  DEFAULT_INDICATOR_HIGHLIGHTS,
  type IndicatorHighlights,
} from "./config.ts";
import { buildVirtText } from "./indicator.ts";

Deno.test("buildVirtText uses phase-specific highlight groups from config", () => {
  const highlights = { ...DEFAULT_INDICATOR_HIGHLIGHTS };
  assertEquals(buildVirtText("idle", "○", highlights), [[
    "○",
    "DiagnosticHint",
  ]]);
  assertEquals(buildVirtText("rec", "●", highlights), [[
    "●",
    "DiagnosticError",
  ]]);
  assertEquals(buildVirtText("stt", "⌛", highlights), [[
    "⌛",
    "DiagnosticWarn",
  ]]);
  assertEquals(buildVirtText("gen", "✎", highlights), [[
    "✎",
    "DiagnosticInfo",
  ]]);
  assertEquals(buildVirtText("error", "⚠", highlights), [[
    "⚠",
    "DiagnosticError",
  ]]);
});

Deno.test("buildVirtText reflects overridden highlight groups", () => {
  const highlights: IndicatorHighlights = {
    ...DEFAULT_INDICATOR_HIGHLIGHTS,
    gen: "Search",
  };
  assertEquals(buildVirtText("gen", "✎", highlights), [["✎", "Search"]]);
});
