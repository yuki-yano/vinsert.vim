import type { Denops } from "./deps/denops.ts";

export async function emitCompletionEvent(
  denops: Denops,
  mode: string,
  success: boolean,
  transcript: string,
  finalText: string,
): Promise<void> {
  await denops.call("nvim_set_var", "vinsert_last_completion", {
    mode,
    success,
    transcript,
    final: finalText,
  });
  await denops.call("nvim_exec2", "doautocmd <nomodeline> User VinsertComplete", { output: false });
}
