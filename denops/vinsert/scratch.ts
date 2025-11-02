import { helper, type Denops } from "./deps/denops.ts";
import type { RuntimeConfig } from "./config.ts";

export type ScratchHandle = {
  bufnr: number;
  winid: number | null;
};

export async function prepareScratch(
  denops: Denops,
  config: RuntimeConfig,
): Promise<ScratchHandle> {
  const command = buildSplitCommand(config.scratch.split, config.scratch.size);
  await helper.execute(denops, command);
  const bufnr = await denops.call("nvim_create_buf", false, true) as number;
  const winid = await denops.call("nvim_get_current_win") as number;
  await denops.call("nvim_win_set_buf", winid, bufnr);
  await denops.call("nvim_buf_set_option", bufnr, "buftype", "nofile");
  await denops.call("nvim_buf_set_option", bufnr, "bufhidden", "wipe");
  await denops.call("nvim_buf_set_option", bufnr, "swapfile", false);
  await denops.call("nvim_buf_set_option", bufnr, "modifiable", true);
  await denops.call("nvim_buf_set_option", bufnr, "filetype", config.scratch.filetype);
  if (!config.scratch.focus) {
    await helper.execute(denops, "wincmd p");
  }
  return { bufnr, winid };
}

export async function replaceScratch(
  denops: Denops,
  handle: ScratchHandle,
  text: string,
): Promise<void> {
  const lines = splitLines(text);
  await denops.call("nvim_buf_set_lines", handle.bufnr, 0, -1, true, lines);
}

export async function appendScratch(
  denops: Denops,
  handle: ScratchHandle,
  text: string,
): Promise<void> {
  const lines = splitLines(text);
  if (lines.length === 0) return;
  const currentLines = await denops.call("nvim_buf_get_lines", handle.bufnr, 0, -1, true) as string[];
  if (currentLines.length === 1 && currentLines[0] === "") {
    await replaceScratch(denops, handle, lines.join("\n"));
    return;
  }
  const newLines = currentLines.concat(lines);
  await denops.call("nvim_buf_set_lines", handle.bufnr, 0, -1, true, newLines);
}

export async function disposeScratch(
  denops: Denops,
  handle: ScratchHandle,
): Promise<void> {
  if (handle.winid !== null) {
    const exists = await denops.call("nvim_win_is_valid", handle.winid) as boolean;
    if (exists) {
      await denops.call("nvim_win_close", handle.winid, true);
    }
  }
}

export function splitLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.split("\n");
}

export function buildSplitCommand(split: string, size: number): string {
  const sanitizedSplit = split.trim() || "botright";
  if (sanitizedSplit.includes("vsplit")) {
    return `${sanitizedSplit} ${Math.max(size, 5)}vsplit`;
  }
  return `${sanitizedSplit} ${Math.max(size, 5)}split`;
}
