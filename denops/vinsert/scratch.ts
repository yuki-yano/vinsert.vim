import { buffer, type Denops, helper, nvimFn, option } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";
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
  const bufnr = ensure(
    await nvimFn.nvim_create_buf(denops, false, true),
    is.Number,
  );
  const winid = ensure(
    await nvimFn.nvim_get_current_win(denops),
    is.Number,
  );
  await nvimFn.nvim_win_set_buf(denops, winid, bufnr);
  await option.buftype.setBuffer(denops, bufnr, "nofile");
  await option.bufhidden.setBuffer(denops, bufnr, "wipe");
  await option.swapfile.setBuffer(denops, bufnr, false);
  await option.modifiable.setBuffer(denops, bufnr, true);
  await option.filetype.setBuffer(denops, bufnr, config.scratch.filetype);
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
  await buffer.replace(denops, handle.bufnr, lines);
}

export async function appendScratch(
  denops: Denops,
  handle: ScratchHandle,
  text: string,
): Promise<void> {
  const lines = splitLines(text);
  if (lines.length === 0) return;
  const currentLines = ensure(
    await nvimFn.nvim_buf_get_lines(denops, handle.bufnr, 0, -1, true),
    is.ArrayOf(is.String),
  );
  if (currentLines.length === 1 && currentLines[0] === "") {
    await replaceScratch(denops, handle, lines.join("\n"));
    return;
  }
  const newLines = currentLines.concat(lines);
  await buffer.replace(denops, handle.bufnr, newLines);
}

export async function disposeScratch(
  denops: Denops,
  handle: ScratchHandle,
): Promise<void> {
  if (handle.winid !== null) {
    const exists = ensure(
      await nvimFn.nvim_win_is_valid(denops, handle.winid),
      is.Boolean,
    );
    if (exists) {
      await nvimFn.nvim_win_close(denops, handle.winid, true);
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
