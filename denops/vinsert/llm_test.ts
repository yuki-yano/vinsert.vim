import { assertEquals } from "./deps/assert.ts";
import { sanitizeDelta } from "./llm.ts";

Deno.test("sanitizeDelta removes control characters", () => {
  const input = "テスト\u0001\u0002\n";
  assertEquals(sanitizeDelta(input), "テスト\n");
});
