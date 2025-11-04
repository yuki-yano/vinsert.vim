import { type Denops, fn, helper } from "./deps/denops.ts";
import {
  DEFAULT_INDICATOR_HIGHLIGHTS,
  type IndicatorHighlights,
  type RuntimeConfig,
} from "./config.ts";

export type IndicatorPhase = "idle" | "rec" | "stt" | "gen" | "error";

const VIRT_LABELS: Record<IndicatorPhase, string> = {
  idle: "○ IDLE",
  rec: "● REC",
  stt: "⌛ STT…",
  gen: "✎ GEN…",
  error: "⚠ ERROR",
};

let namespaceId: number | null = null;
let virtState: { bufnr: number; markId: number } | null = null;
let blinkTimer: number | null = null;
let blinkToggle = false;
let anchor: { bufnr: number; row: number } | null = null;
let currentPhase: IndicatorPhase = "idle";
let lastConfig: RuntimeConfig | null = null;

export function setIndicatorAnchor(
  value: { bufnr: number; row: number } | null,
): void {
  anchor = value ? { bufnr: value.bufnr, row: value.row } : null;
}

export function getIndicatorAnchor():
  | { bufnr: number; row: number }
  | null {
  return anchor ? { bufnr: anchor.bufnr, row: anchor.row } : null;
}

async function ensureNamespace(denops: Denops): Promise<number> {
  if (namespaceId !== null) return namespaceId;
  namespaceId = await denops.call(
    "nvim_create_namespace",
    "vinsert.indicator",
  ) as number;
  return namespaceId;
}

export async function setPhase(
  denops: Denops,
  phase: IndicatorPhase,
  config: RuntimeConfig,
): Promise<void> {
  currentPhase = phase;
  lastConfig = config;
  if (config.indicatorMode !== "virt") {
    await removeIndicator(denops, true);
    if (phase === "error") {
      await helper.echoerr(
        denops,
        "[vinsert] An error occurred. Check :messages for details.",
      );
    }
    return;
  }
  if (phase === "idle") {
    await removeIndicator(denops, true);
    return;
  }
  await renderIndicator(denops, phase, config);
}

export async function refreshIndicator(
  denops: Denops,
  config?: RuntimeConfig,
): Promise<void> {
  if (currentPhase === "idle") {
    return;
  }
  const effectiveConfig = config ?? lastConfig;
  if (!effectiveConfig || effectiveConfig.indicatorMode !== "virt") {
    return;
  }
  lastConfig = effectiveConfig;
  await renderIndicator(denops, currentPhase, effectiveConfig);
}

export async function clearIndicator(denops: Denops): Promise<void> {
  currentPhase = "idle";
  lastConfig = null;
  await removeIndicator(denops, true);
}

async function renderIndicator(
  denops: Denops,
  phase: IndicatorPhase,
  config: RuntimeConfig,
): Promise<void> {
  const baseAnchor = await ensureAnchor(denops);
  const row = await clampAnchorRow(denops, baseAnchor.bufnr, baseAnchor.row);
  anchor = { bufnr: baseAnchor.bufnr, row };
  const ns = await ensureNamespace(denops);
  if (virtState && virtState.bufnr !== baseAnchor.bufnr) {
    await denops.call(
      "nvim_buf_del_extmark",
      virtState.bufnr,
      ns,
      virtState.markId,
    ).catch(() => {});
    virtState = null;
  }
  const virtText = buildVirtText(
    phase,
    VIRT_LABELS[phase],
    config.indicatorHighlights,
  );
  const options: Record<string, unknown> = {
    virt_text: virtText,
    virt_text_pos: "eol",
  };
  if (virtState) {
    options.id = virtState.markId;
  }
  const markId = await denops.call(
    "nvim_buf_set_extmark",
    baseAnchor.bufnr,
    ns,
    row,
    -1,
    options,
  ) as number;
  virtState = { bufnr: baseAnchor.bufnr, markId };
  if (phase === "rec") {
    startBlink(denops, baseAnchor.bufnr, ns, row, config.indicatorHighlights);
  } else {
    stopBlink();
  }
}

async function ensureAnchor(
  denops: Denops,
): Promise<{ bufnr: number; row: number }> {
  if (anchor) {
    return anchor;
  }
  const bufnr = await fn.bufnr(denops, "%") as number;
  const pos = await fn.getpos(denops, ".") as unknown[];
  const row = Math.max(Number(pos[1]) - 1, 0);
  anchor = { bufnr, row };
  return anchor;
}

async function clampAnchorRow(
  denops: Denops,
  bufnr: number,
  row: number,
): Promise<number> {
  const lineCount = await denops.call("nvim_buf_line_count", bufnr) as number;
  const maxRow = Math.max(lineCount - 1, 0);
  return Math.max(0, Math.min(row, maxRow));
}

export function buildVirtText(
  phase: IndicatorPhase,
  label: string,
  highlights: IndicatorHighlights,
): Array<[string, string]> {
  const highlight = highlights?.[phase] ?? DEFAULT_INDICATOR_HIGHLIGHTS[phase];
  return [[label, highlight]];
}

export function indicatorLabel(phase: IndicatorPhase): string {
  return VIRT_LABELS[phase];
}

function startBlink(
  denops: Denops,
  bufnr: number,
  ns: number,
  row: number,
  highlights: IndicatorHighlights,
): void {
  stopBlink();
  blinkTimer = setInterval(async () => {
    blinkToggle = !blinkToggle;
    if (!virtState) return;
    const label = blinkToggle ? "● REC" : "○ REC";
    try {
      await denops.call(
        "nvim_buf_set_extmark",
        bufnr,
        ns,
        row,
        -1,
        {
          id: virtState.markId,
          virt_text: buildVirtText("rec", label, highlights),
          virt_text_pos: "eol",
        },
      );
    } catch {
      // noop
    }
  }, 500);
}

function stopBlink(): void {
  if (blinkTimer !== null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
  blinkToggle = false;
}

async function removeIndicator(
  denops: Denops,
  resetAnchor: boolean,
): Promise<void> {
  stopBlink();
  if (virtState) {
    const { bufnr, markId } = virtState;
    const ns = await ensureNamespace(denops);
    await denops.call("nvim_buf_del_extmark", bufnr, ns, markId).catch(
      () => {},
    );
    virtState = null;
  }
  if (resetAnchor) {
    anchor = null;
  }
}
