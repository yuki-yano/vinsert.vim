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

export function setIndicatorAnchor(
  value: { bufnr: number; row: number },
): void {
  anchor = value;
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
  if (config.indicatorMode !== "virt") {
    if (phase === "error") {
      await helper.echoerr(
        denops,
        "[vinsert] An error occurred. Check :messages for details.",
      );
    }
    return;
  }
  await removeIndicator(denops, phase === "idle");
  if (phase === "idle") {
    stopBlink();
    return;
  }
  if (!anchor) {
    const bufnr = await fn.bufnr(denops, "%") as number;
    const pos = await fn.getpos(denops, ".") as unknown[];
    anchor = { bufnr, row: Math.max(Number(pos[1]) - 1, 0) };
  }
  const { bufnr, row } = anchor!;
  const ns = await ensureNamespace(denops);
  const virtText = buildVirtText(
    phase,
    VIRT_LABELS[phase],
    config.indicatorHighlights,
  );
  const markId = await denops.call(
    "nvim_buf_set_extmark",
    bufnr,
    ns,
    row,
    -1,
    {
      virt_text: virtText,
      virt_text_pos: "eol",
    },
  ) as number;
  virtState = { bufnr, markId };
  if (phase === "rec") {
    startBlink(denops, bufnr, ns, row, config.indicatorHighlights);
  } else {
    stopBlink();
  }
}

export async function clearIndicator(denops: Denops): Promise<void> {
  await removeIndicator(denops, true);
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
