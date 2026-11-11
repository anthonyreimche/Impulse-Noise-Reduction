// The param-bag contract. The edit is RawTherapee's pp3 keys as they are, under
// the stage's qualified keys: Enabled (stored 0 or 1, because the passes draw
// as many times as the switch says) and Threshold.

import { DEFAULT_PARAMS, RANGES, type Params } from "./model";

export const EXT_ID = "impulse-noise-reduction";
export const STAGE_ID = `${EXT_ID}.denoise`;

export const TITLE = "Impulse Noise Reduction";

/** The control names, shared by the panel and the stage's uniforms. */
export const LABELS = { enabled: "Enabled", threshold: "Threshold" } as const;

/** A history step for one control, and for the reset. */
export const historyLabel = (key: keyof typeof LABELS): string => `${TITLE}: ${LABELS[key]}`;
export const RESET_LABEL = `${TITLE} reset`;

export type EditKey = keyof Params;
export const EDIT_KEYS: readonly EditKey[] = ["enabled", "threshold"];

export const qualified = (key: EditKey): string => `${STAGE_ID}.${key}`;

type Bag = Readonly<Record<string, unknown>>;
type Patch = Record<string, number>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `bag` is the host's untyped per-photo bag; a missing or non-finite value reads as RawTherapee's default. */
export function readParams(bag: Bag): Params {
  const enabled = bag[qualified("enabled")];
  const threshold = bag[qualified("threshold")];
  return {
    enabled: finite(enabled) ? enabled !== 0 : DEFAULT_PARAMS.enabled,
    threshold: finite(threshold)
      ? Math.min(Math.max(Math.round(threshold), RANGES.threshold.min), RANGES.threshold.max)
      : DEFAULT_PARAMS.threshold,
  };
}

export function bagPatch(p: Params): Patch {
  return { [qualified("enabled")]: p.enabled ? 1 : 0, [qualified("threshold")]: p.threshold };
}

export const resetPatch = (): Patch => bagPatch(DEFAULT_PARAMS);
