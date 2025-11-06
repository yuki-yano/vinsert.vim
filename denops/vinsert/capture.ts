import type { RuntimeConfig } from "./config.ts";
import type {
  IndicatorAnchor,
  InsertAnchor,
  SessionContext,
} from "./session.ts";
import type { InsertReservation } from "./buffer.ts";

export type LastCapture = {
  wav: Uint8Array;
  session: {
    config: RuntimeConfig;
    mode: SessionContext["mode"];
    reservation: InsertReservation | null;
    insertAnchor: InsertAnchor;
    indicatorAnchor: IndicatorAnchor;
  };
  result: {
    transcript: string;
    resolvedText: string;
  };
};

export function createLastCaptureRecord(
  session: SessionContext,
  transcript: string,
  wav: Uint8Array,
): LastCapture {
  return {
    wav: wav.slice(),
    session: {
      config: cloneRuntimeConfig(session.config),
      mode: session.mode,
      reservation: session.reservation
        ? cloneReservation(session.reservation)
        : null,
      insertAnchor: cloneInsertAnchor(session.insertAnchor),
      indicatorAnchor: cloneIndicatorAnchor(session.indicatorAnchor),
    },
    result: {
      transcript,
      resolvedText: session.resolvedText,
    },
  };
}

export function restoreSessionStateFromCapture(
  session: SessionContext,
  capture: LastCapture,
): void {
  session.mode = capture.session.mode;
  session.insertAnchor = cloneInsertAnchor(capture.session.insertAnchor);
  session.indicatorAnchor = cloneIndicatorAnchor(
    capture.session.indicatorAnchor,
  );
  session.reservation = capture.session.reservation
    ? cloneReservation(capture.session.reservation)
    : null;
}

export function cloneRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    ffmpegArgs: [...config.ffmpegArgs],
    llmRequestOptions: { ...config.llmRequestOptions },
    indicatorHighlights: { ...config.indicatorHighlights },
    scratch: { ...config.scratch },
  };
}

function cloneReservation(
  reservation: InsertReservation,
): InsertReservation {
  return { ...reservation };
}

function cloneInsertAnchor(anchor: InsertAnchor): InsertAnchor {
  if (!anchor) {
    return null;
  }
  return { ...anchor };
}

function cloneIndicatorAnchor(anchor: IndicatorAnchor): IndicatorAnchor {
  if (!anchor) {
    return null;
  }
  return { ...anchor };
}
