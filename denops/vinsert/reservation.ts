import { ensure, is } from "./deps/unknownutil.ts";
import { type Denops, nvimFn } from "./deps/denops.ts";
import type { SessionContext } from "./session.ts";
import {
  type InsertReservation,
  reserveInsertRange,
  sanitizeReservation,
} from "./buffer.ts";

let reservationNamespace: number | null = null;

export async function ensureReservationNamespace(
  denops: Denops,
): Promise<number> {
  if (reservationNamespace !== null) {
    return reservationNamespace;
  }
  reservationNamespace = ensure(
    await nvimFn.nvim_create_namespace(denops, "vinsert.session"),
    is.Number,
  );
  return reservationNamespace;
}

export async function syncSessionAnchors(
  denops: Denops,
  session: SessionContext,
): Promise<void> {
  if (!session.insertAnchor || session.reservationMarkId === null) {
    return;
  }
  const ns = await ensureReservationNamespace(denops);
  try {
    const position = ensure(
      await nvimFn.nvim_buf_get_extmark_by_id(
        denops,
        session.insertAnchor.bufnr,
        ns,
        session.reservationMarkId,
        {},
      ),
      is.ArrayOf(is.Number),
    );
    if (position.length < 2) {
      return;
    }
    const [markRow, markCol] = position;
    const previous = session.insertAnchor;
    if (markRow === previous.row && markCol === previous.col) {
      return;
    }
    const rowDiff = markRow - previous.row;
    const colDiff = markCol - previous.col;
    session.insertAnchor = {
      bufnr: previous.bufnr,
      row: markRow,
      col: markCol,
    };
    session.indicatorAnchor = {
      bufnr: previous.bufnr,
      row: markRow,
    };
    if (session.reservation) {
      const updatedReservation = {
        ...session.reservation,
        startRow: markRow,
        startCol: markCol,
        endRow: session.reservation.endRow + rowDiff,
        endCol: session.reservation.endCol +
          (rowDiff === 0 ? colDiff : 0),
      };
      const sanitized = await sanitizeReservation(
        denops,
        updatedReservation,
        false,
      );
      Object.assign(session.reservation, sanitized);
    }
  } catch {
    // ignore extmark lookup failures
  }
}

export async function initializeSessionReservationMark(
  denops: Denops,
  session: SessionContext,
): Promise<void> {
  if (!session.insertAnchor) {
    return;
  }
  const ns = await ensureReservationNamespace(denops);
  const options: Record<string, unknown> = {
    right_gravity: true,
  };
  if (session.reservationMarkId !== null) {
    options.id = session.reservationMarkId;
  }
  session.reservationMarkId = ensure(
    await nvimFn.nvim_buf_set_extmark(
      denops,
      session.insertAnchor.bufnr,
      ns,
      session.insertAnchor.row,
      session.insertAnchor.col,
      options,
    ),
    is.Number,
  );
}

export async function ensureSessionInsertReservation(
  denops: Denops,
  session: SessionContext,
): Promise<InsertReservation> {
  if (!session.insertAnchor) {
    const fallback = await reserveInsertRange(denops);
    session.insertAnchor = {
      bufnr: fallback.bufnr,
      row: fallback.startRow,
      col: fallback.startCol,
    };
    session.indicatorAnchor = {
      bufnr: fallback.bufnr,
      row: fallback.startRow,
    };
    await initializeSessionReservationMark(denops, session);
    return fallback;
  }
  await initializeSessionReservationMark(denops, session);
  const ns = await ensureReservationNamespace(denops);
  const bufnr = session.insertAnchor.bufnr;
  const isNumberArray = is.ArrayOf(is.Number);
  let rawPosition = await nvimFn.nvim_buf_get_extmark_by_id(
    denops,
    bufnr,
    ns,
    session.reservationMarkId,
    {},
  );
  let position = isNumberArray(rawPosition) ? rawPosition : [];
  if (position.length < 2) {
    session.reservationMarkId = ensure(
      await nvimFn.nvim_buf_set_extmark(
        denops,
        bufnr,
        ns,
        session.insertAnchor.row,
        session.insertAnchor.col,
        {
          right_gravity: true,
        },
      ),
      is.Number,
    );
    rawPosition = await nvimFn.nvim_buf_get_extmark_by_id(
      denops,
      bufnr,
      ns,
      session.reservationMarkId,
      {},
    );
    position = isNumberArray(rawPosition) ? rawPosition : [];
  }
  if (position.length < 2) {
    position = [session.insertAnchor.row, session.insertAnchor.col];
  }
  const [markRow, markCol] = position;
  const sanitized = await sanitizeReservation(denops, {
    bufnr,
    startRow: markRow,
    startCol: markCol,
    endRow: markRow,
    endCol: markCol,
  }, false);
  session.reservationMarkId = ensure(
    await nvimFn.nvim_buf_set_extmark(
      denops,
      bufnr,
      ns,
      sanitized.startRow,
      sanitized.startCol,
      {
        right_gravity: true,
        ...(session.reservationMarkId !== null
          ? { id: session.reservationMarkId }
          : {}),
      },
    ),
    is.Number,
  );
  session.insertAnchor = {
    bufnr: sanitized.bufnr,
    row: sanitized.startRow,
    col: sanitized.startCol,
  };
  session.indicatorAnchor = {
    bufnr: sanitized.bufnr,
    row: sanitized.startRow,
  };
  return sanitized;
}
