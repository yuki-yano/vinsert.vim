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
): StatusSnapshot {
  const indicatorPhase = toIndicatorPhase(phase);
  return {
    phase,
    mode,
    indicatorPhase,
    label: indicatorLabel(indicatorPhase),
    active: phase === "recording" || phase === "stt" || phase === "gen",
    error: phase === "error",
  };
}
