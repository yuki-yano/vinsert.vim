import { type Denops, fn, helper } from "./deps/denops.ts";

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
  const bufnr = await fn.bufnr(denops, "%") as number;
  const pos = await fn.getpos(denops, ".") as unknown[];
  const startRow = Number(pos[1]) - 1;
  const startCol = Math.max(Number(pos[2]) - 1, 0);
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
    await denops.call(
      "nvim_buf_set_text",
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
    await denops.call(
      "nvim_buf_set_text",
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

export async function finalizeUndo(denops: Denops): Promise<void> {
  await helper.execute(
    denops,
    "silent! call win_execute(winnr(), 'normal! \\<Esc>')",
  );
}
function splitLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized.split("\n");
}

export function updateReservation(
  reservation: InsertReservation,
  lines: string[],
  append = false,
): void {
  if (append) {
    const [first, ...rest] = lines;
    if (rest.length === 0) {
      reservation.endCol += first.length;
    } else {
      reservation.endRow += rest.length;
      reservation.endCol = rest.at(-1)?.length ?? 0;
    }
    return;
  }
  const lastLine = lines.at(-1) ?? "";
  reservation.endRow = reservation.startRow + (lines.length - 1);
  reservation.endCol = lines.length === 1
    ? reservation.startCol + lastLine.length
    : lastLine.length;
}

export async function sanitizeReservation(
  denops: Denops,
  reservation: InsertReservation,
  append: boolean,
): Promise<InsertReservation> {
  const copy: InsertReservation = { ...reservation };
  const lineCount = await denops.call(
    "nvim_buf_line_count",
    reservation.bufnr,
  ) as number;
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
  const lines = await denops.call(
    "nvim_buf_get_lines",
    bufnr,
    row,
    row + 1,
    true,
  ) as string[];
  return lines[0]?.length ?? 0;
}
