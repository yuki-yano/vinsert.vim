import { type Denops, fn, helper, nvimFn } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";

export type InsertReservation = {
  bufnr: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

type InsertStreamOptions = {
  replace?: boolean;
  append?: boolean;
};

export async function reserveInsertRange(
  denops: Denops,
): Promise<InsertReservation> {
  const bufnr = ensure(await fn.bufnr(denops, "%"), is.Number);
  const pos = ensure(await fn.getpos(denops, "."), is.ArrayOf(is.Number));
  const startRow = Math.max((pos[1] ?? 1) - 1, 0);
  const startCol = Math.max((pos[2] ?? 1) - 1, 0);
  return {
    bufnr,
    startRow,
    startCol,
    endRow: startRow,
    endCol: startCol,
  };
}

export async function insertStream(
  denops: Denops,
  reservation: InsertReservation,
  text: string,
  options: InsertStreamOptions = {},
): Promise<void> {
  const lines = splitLines(text);
  if (options.replace) {
    const sanitized = await sanitizeReservation(denops, reservation, false);
    await helper.execute(
      denops,
      `silent! undojoin | silent!`,
    );
    await nvimFn.nvim_buf_set_text(
      denops,
      sanitized.bufnr,
      sanitized.startRow,
      sanitized.startCol,
      sanitized.endRow,
      sanitized.endCol,
      lines,
    );
    Object.assign(reservation, sanitized);
    updateReservation(reservation, lines);
    return;
  }
  if (options.append) {
    const sanitized = await sanitizeReservation(denops, reservation, true);
    await helper.execute(denops, `silent! undojoin | silent!`);
    await nvimFn.nvim_buf_set_text(
      denops,
      sanitized.bufnr,
      sanitized.endRow,
      sanitized.endCol,
      sanitized.endRow,
      sanitized.endCol,
      lines,
    );
    Object.assign(reservation, sanitized);
    updateReservation(reservation, lines, true);
    return;
  }
  // default: append
  await insertStream(denops, reservation, text, { append: true });
}

export async function finalizeUndo(
  denops: Denops,
  bufnr: number,
): Promise<void> {
  const winnr = ensure(await fn.bufwinnr(denops, bufnr), is.Number);
  if (typeof winnr !== "number" || winnr <= 0) {
    return;
  }
  await helper.execute(
    denops,
    `silent! call win_execute(${winnr}, 'normal! \\<Esc>')`,
  );
}
const encoder = new TextEncoder();

function splitLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.split("\n");
}

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export function updateReservation(
  reservation: InsertReservation,
  lines: string[],
  append = false,
): void {
  if (append) {
    const [first, ...rest] = lines;
    if (rest.length === 0) {
      reservation.endCol += byteLength(first);
    } else {
      reservation.endRow += rest.length;
      reservation.endCol = byteLength(rest.at(-1) ?? "");
    }
    return;
  }
  const lastLine = lines.at(-1) ?? "";
  reservation.endRow = reservation.startRow + (lines.length - 1);
  reservation.endCol = lines.length === 1
    ? reservation.startCol + byteLength(lastLine)
    : byteLength(lastLine);
}

export async function sanitizeReservation(
  denops: Denops,
  reservation: InsertReservation,
  append: boolean,
): Promise<InsertReservation> {
  const copy: InsertReservation = { ...reservation };
  const lineCount = ensure(
    await nvimFn.nvim_buf_line_count(
      denops,
      reservation.bufnr,
    ),
    is.Number,
  );
  const maxRow = Math.max(lineCount - 1, 0);
  const clampRow = (row: number) => Math.min(Math.max(row, 0), maxRow);
  copy.startRow = clampRow(copy.startRow);
  copy.endRow = clampRow(copy.endRow);
  const startLen = await lineLength(denops, copy.bufnr, copy.startRow);
  const endLen = await lineLength(denops, copy.bufnr, copy.endRow);
  copy.startCol = Math.min(Math.max(copy.startCol, 0), startLen);
  copy.endCol = Math.min(Math.max(copy.endCol, 0), endLen);
  if (append) {
    copy.startRow = copy.endRow;
    copy.startCol = copy.endCol;
  }
  return copy;
}

async function lineLength(
  denops: Denops,
  bufnr: number,
  row: number,
): Promise<number> {
  const lines = ensure(
    await nvimFn.nvim_buf_get_lines(
      denops,
      bufnr,
      row,
      row + 1,
      true,
    ),
    is.ArrayOf(is.String),
  );
  return lines[0] ? byteLength(lines[0]) : 0;
}
