import { assertEquals } from "./deps/assert.ts";
import {
  type InsertReservation,
  reserveInsertRange,
  updateReservation,
} from "./buffer.ts";

Deno.test({
  name: "reserveInsertRange converts 1-based col to 0-based",
  async fn() {
    const mockDenops = {
      call(method: string) {
        if (method === "bufnr") return Promise.resolve(1);
        if (method === "getpos") return Promise.resolve([0, 3, 5]);
        return Promise.reject(new Error(`unexpected call ${method}`));
      },
    } as unknown as import("./deps/denops.ts").Denops;
    const range = await reserveInsertRange(mockDenops);
    assertEquals(range.startRow, 2);
    assertEquals(range.startCol, 4);
  },
});

Deno.test("updateReservation append adjusts columns", () => {
  const reservation: InsertReservation = {
    bufnr: 1,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
  };
  updateReservation(reservation, ["hello"], true);
  assertEquals(reservation.endRow, 0);
  assertEquals(reservation.endCol, 5);

  updateReservation(reservation, ["world", "foo"], true);
  assertEquals(reservation.endRow, 1);
  assertEquals(reservation.endCol, 3);
});

Deno.test("updateReservation replace resets to text length", () => {
  const reservation: InsertReservation = {
    bufnr: 1,
    startRow: 0,
    startCol: 2,
    endRow: 0,
    endCol: 2,
  };
  updateReservation(reservation, ["hello"], false);
  assertEquals(reservation.endRow, 0);
  assertEquals(reservation.endCol, 7);
});
