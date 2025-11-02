import { assertEquals } from "./deps/assert.ts";
import { buildSplitCommand, splitLines } from "./scratch.ts";

Deno.test("splitLines normalizes carriage returns", () => {
  assertEquals(splitLines("a\rb"), ["a", "b"]);
  assertEquals(splitLines("a\r\nb"), ["a", "b"]);
});

Deno.test("buildSplitCommand respects split direction", () => {
  assertEquals(buildSplitCommand("botright", 10), "botright 10split");
  assertEquals(buildSplitCommand("topleft", 5), "topleft 5split");
  assertEquals(buildSplitCommand("belowright vsplit", 20), "belowright vsplit 20vsplit");
  assertEquals(buildSplitCommand("", 0), "botright 5split");
});
