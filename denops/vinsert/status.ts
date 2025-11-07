import { indicatorLabel, type IndicatorPhase } from "./indicator.ts";

export type StatusPhase = "idle" | "recording" | "stt" | "gen" | "error";
export type StatusMode = "insert" | "yank" | "scratch";

export type StatusSnapshot = {
  phase: StatusPhase;
  mode: StatusMode;
  indicatorPhase: IndicatorPhase;
  label: string;
  active: boolean;
  error: boolean;
  segmentIndex: number;
};

export function toIndicatorPhase(phase: StatusPhase): IndicatorPhase {
  switch (phase) {
    case "recording":
      return "rec";
    case "stt":
      return "stt";
    case "gen":
      return "gen";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

export function buildStatusSnapshot(
  phase: StatusPhase,
  mode: StatusMode,
  segmentIndex = 1,
): StatusSnapshot {
  const indicatorPhase = toIndicatorPhase(phase);
  const normalizedIndex = Math.max(segmentIndex, 1);
  const label = indicatorPhase === "rec"
    ? recordingLabel(normalizedIndex)
    : indicatorLabel(indicatorPhase);
  return {
    phase,
    mode,
    indicatorPhase,
    label,
    active: phase === "recording" || phase === "stt" || phase === "gen",
    error: phase === "error",
    segmentIndex: normalizedIndex,
  };
}

function recordingLabel(segmentIndex: number): string {
  return segmentIndex >= 2 ? `REC (${segmentIndex})` : "REC";
}
