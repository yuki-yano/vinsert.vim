import { type Denops, helper, variable } from "./deps/denops.ts";

export async function emitCompletionEvent(
  denops: Denops,
  mode: string,
  success: boolean,
  transcript: string,
  resolvedText: string,
): Promise<void> {
  await variable.g.set(denops, "vinsert_last_completion", {
    mode,
    success,
    transcript,
    final: resolvedText,
  });
  await helper.execute(denops, "doautocmd <nomodeline> User VinsertComplete");
}

export async function emitLogEvent(
  denops: Denops,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  await variable.g.set(denops, "vinsert_last_log", {
    level,
    message,
  });
  await helper.execute(denops, "doautocmd <nomodeline> User VinsertLog");
}
