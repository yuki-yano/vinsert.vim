import { type Denops, fn, helper, nvimFn } from "./deps/denops.ts";
import { ensure, is } from "./deps/unknownutil.ts";
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
let currentSegmentIndex = 1;
let currentRecordingLabel: string | null = null;

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
  const id = ensure(
    await nvimFn.nvim_create_namespace(denops, "vinsert.indicator"),
    is.Number,
  );
  namespaceId = id;
  return namespaceId;
}

export async function setPhase(
  denops: Denops,
  phase: IndicatorPhase,
  config: RuntimeConfig,
  options?: { segmentIndex?: number; label?: string },
): Promise<void> {
  currentPhase = phase;
  lastConfig = config;
  if (phase === "rec") {
    currentSegmentIndex = Math.max(options?.segmentIndex ?? 1, 1);
    currentRecordingLabel = options?.label ?? null;
  } else if (phase === "idle") {
    currentSegmentIndex = 1;
    currentRecordingLabel = null;
  }
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
  const ns = await ensureNamespace(denops);
  let anchorRow = baseAnchor.row;
  if (virtState && virtState.bufnr === baseAnchor.bufnr) {
    try {
      const position = ensure(
        await nvimFn.nvim_buf_get_extmark_by_id(
          denops,
          virtState.bufnr,
          ns,
          virtState.markId,
          {},
        ),
        is.ArrayOf(is.Number),
      );
      if (position.length >= 2) {
        anchorRow = position[0];
      }
    } catch {
      // ignore lookup failures
    }
  }
  const row = await clampAnchorRow(denops, baseAnchor.bufnr, anchorRow);
  anchor = { bufnr: baseAnchor.bufnr, row };
  if (virtState && virtState.bufnr !== baseAnchor.bufnr) {
    await nvimFn.nvim_buf_del_extmark(
      denops,
      virtState.bufnr,
      ns,
      virtState.markId,
    ).catch(() => {});
    virtState = null;
  }
  const displayLabel = phase === "rec"
    ? formatRecordingLabel(
      currentSegmentIndex,
      true,
      currentRecordingLabel ?? undefined,
    )
    : VIRT_LABELS[phase];
  const virtText = buildVirtText(
    phase,
    displayLabel,
    config.indicatorHighlights,
  );
  const options: Record<string, unknown> = {
    virt_text: virtText,
    virt_text_pos: "eol",
  };
  if (virtState) {
    options.id = virtState.markId;
  }
  const markId = ensure(
    await nvimFn.nvim_buf_set_extmark(
      denops,
      baseAnchor.bufnr,
      ns,
      row,
      -1,
      options,
    ),
    is.Number,
  );
  virtState = { bufnr: baseAnchor.bufnr, markId };
  if (phase === "rec") {
    startBlink(
      denops,
      baseAnchor.bufnr,
      ns,
      row,
      config.indicatorHighlights,
      currentSegmentIndex,
    );
  } else {
    stopBlink();
    currentRecordingLabel = null;
  }
}

async function ensureAnchor(
  denops: Denops,
): Promise<{ bufnr: number; row: number }> {
  if (anchor) {
    return anchor;
  }
  const bufnr = ensure(await fn.bufnr(denops, "%"), is.Number);
  const pos = ensure(await fn.getpos(denops, "."), is.ArrayOf(is.Number));
  const row = Math.max((pos[1] ?? 1) - 1, 0);
  anchor = { bufnr, row };
  return anchor;
}

async function clampAnchorRow(
  denops: Denops,
  bufnr: number,
  row: number,
): Promise<number> {
  const lineCount = ensure(
    await nvimFn.nvim_buf_line_count(denops, bufnr),
    is.Number,
  );
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

function formatRecordingLabel(
  segmentIndex: number,
  filled: boolean,
  custom?: string,
): string {
  const suffix = custom && custom.length > 0
    ? custom
    : segmentIndex >= 2
    ? `REC (${segmentIndex})`
    : "REC";
  const bullet = filled ? "●" : "○";
  return `${bullet} ${suffix}`;
}

function startBlink(
  denops: Denops,
  bufnr: number,
  ns: number,
  row: number,
  highlights: IndicatorHighlights,
  segmentIndex: number,
): void {
  stopBlink();
  let currentRow = row;
  blinkTimer = setInterval(async () => {
    blinkToggle = !blinkToggle;
    if (!virtState) return;
    const label = formatRecordingLabel(
      segmentIndex,
      !blinkToggle,
      currentRecordingLabel ?? undefined,
    );
    if (virtState.bufnr === bufnr) {
      try {
        const position = ensure(
          await nvimFn.nvim_buf_get_extmark_by_id(
            denops,
            bufnr,
            ns,
            virtState.markId,
            {},
          ),
          is.ArrayOf(is.Number),
        );
        if (position.length >= 2) {
          currentRow = position[0];
        }
      } catch {
        // ignore lookup failures
      }
    }
    anchor = { bufnr, row: currentRow };
    try {
      await nvimFn.nvim_buf_set_extmark(
        denops,
        bufnr,
        ns,
        currentRow,
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
    await nvimFn.nvim_buf_del_extmark(denops, bufnr, ns, markId).catch(
      () => {},
    );
    virtState = null;
  }
  if (resetAnchor) {
    anchor = null;
  }
}
