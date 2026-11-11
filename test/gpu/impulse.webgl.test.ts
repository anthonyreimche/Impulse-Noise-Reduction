// The stage on the real renderer. Run via `npm run test:gpu` (run.cjs copies
// this file into a SafeLight checkout and runs it under its headless
// Chromium + SwiftShader rig). What the CPU suite cannot check:
//
//  • the five four-channel passes compile with the host's namespacing and run
//    only while the switch is on;
//  • with the switch off the frame is as it was;
//  • on half-float targets, the Lab conversion, the blur's taps (computed in
//    the shader from the recursion's coefficients), the flags and the
//    replacement land on RawTherapee's result, here the CPU transcription
//    test/reference/rtref.ts, which rtref.test.ts holds to rawtherapee-cli;
//  • a mask's copy treats the pixels inside the mask only;
//  • the widest blur still draws on a frame as wide as the default render.
//
// The transcription is run with the far end of each line started as
// RawTherapee's own SSE routines start it ("rt"), which the shaders reproduce
// with the far-edge correction USM and RL Sharpening carries; the fixture test
// holds that to rawtherapee-cli.
//
// The passes store half floats. A pixel whose flag sits at a rounding of the
// threshold can flip on either side; those are counted, and must stay within a
// per cent or two of the pixels changed.

import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "@inr/model";
import { bagPatch } from "@inr/params";
import { impulseStage } from "@inr/stage";
import { impulseDenoise, impulseFlags, rgbToLab } from "@inr-test/reference/rtref";
import { defaultMaskAdjustments, type Mask } from "@/catalog/types";
import { CURRENT_PROCESS_VERSION } from "@/catalog/process-version";
import type { ProcessingStageContribution } from "@/extensions/types";
import { toStageSpace } from "@/rendering/stage-space";
import { OPEN_PROBE, builtinStages, floatImage, identityParams, withRenderer } from "@/rendering/webgl/webgl.test-support";
import type { FloatImage } from "@/rendering/webgl/webgl.test-support";

const W = 192;
const H = 128;
const SPACE = { encoding: "linear", primaries: "rec709" } as const;
const AS_DRAWN = { encoding: "perceptual", primaries: "rec709" } as const;
/** Per-pixel agreement with the transcription, in linear light: the half-float floor of the frame at 1.5. */
const TOLERANCE = 3e-3;
/** The share of the changed pixels that may sit on the other side of a flag's near-tie. */
const TIE_SHARE = 0.015;
/** Frames the stage never touches, compared as float32 frames: SwiftShader lands within 1e-6, ANGLE's D3D11 at 1.004e-6 (about 8 ulp) with or without this stage's half-float rounding, so the rounding is not its cause. */
const UNTOUCHED = 2e-6;
/** A mask's outside after the colour-space round trip of its copy, absolute near 0.9: SwiftShader lands within 5e-7, D3D11 at 2e-6 both before and after the stage rounded its stores itself. */
const OUTSIDE = 4e-6;

/** A deterministic hash in [0, 1). */
function hash(x: number, y: number, salt = 0): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Display values: texture on the left, flat steps in the middle, a gradient
 *  and a coloured disc on the right, a block past white, then impulses
 *  everywhere, including the corners, the borders and one touching pair. */
const SCENE = floatImage(W, H, (x, y) => {
  let v: [number, number, number];
  if (x < 64) {
    const t = 0.45 + 0.07 * (hash(x, y) - 0.5) + 0.03 * Math.sin(x * 0.8) * Math.sin(y * 0.6);
    v = [t * 1.1, t, t * 0.8];
  } else if (x < 128) {
    const level = [0.1, 0.3, 0.55, 0.8][Math.floor(y / (H / 4))];
    v = x < 96 ? [level, level, level] : [level * 0.7, level * 0.9, level];
  } else {
    const g = 0.1 + 0.7 * (y / H);
    v = (x - 160) ** 2 + (y - 80) ** 2 < 18 ** 2 ? [0.2, 0.5, 0.25] : [g, g * 0.9, g * 0.7];
  }
  if (x >= 140 && x < 160 && y >= 10 && y < 40) v = [1.2, 1.1, 1.0];
  const r = hash(x, y, 1);
  if (r < 0.012) v = [0.92, 0.92, 0.92];
  else if (r < 0.024) v = [0.01, 0.01, 0.01];
  else if (r < 0.032) v = [v[0], 0.95, v[2]];
  return v;
});
const FORCED: [number, number, number][] = [
  [0, 0, 0.93],
  [W - 1, H - 1, 0.01],
  [W - 1, 5, 0.95],
  [7, H - 1, 0.9],
  [0, 64, 0.02],
  [30, 30, 0.93],
  [31, 30, 0.93],
];
for (const [x, y, v] of FORCED) SCENE.data.set([v, v, v, 1], (y * W + x) * 4);

const THRESHOLDS = [0, 25, 50, 61, 80, 100];

type Bag = Record<string, unknown>;
const on = (threshold: number): Bag => bagPatch({ ...DEFAULT_PARAMS, enabled: true, threshold });
const off: Bag = bagPatch(DEFAULT_PARAMS);

function render(
  bags: Record<string, Bag>,
  stages: ProcessingStageContribution[] = [impulseStage() as ProcessingStageContribution],
  image: FloatImage = SCENE,
  masks: Mask[] = [],
) {
  const frames: Record<string, Float32Array> = {};
  withRenderer({ stages: [...builtinStages(), ...stages], pipeline: OPEN_PROBE }, (renderer) => {
    renderer.setImage(image);
    renderer.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION, masks }));
    for (const [name, bag] of Object.entries(bags)) {
      renderer.setContributedParams(bag);
      const frame = renderer.readFloatFrame("pre-output", Infinity, AS_DRAWN);
      if (!frame) throw new Error(`no frame for ${name}`);
      frames[name] = frame.data;
    }
  });
  return frames;
}

/** A frame (display values, RGBA) in the stage's space, RGB only. */
function linear(frame: Float32Array, count = W * H): Float32Array {
  const out = new Float32Array(count * 3);
  for (let p = 0; p < count; p++) out.set(toStageSpace([frame[4 * p], frame[4 * p + 1], frame[4 * p + 2]], SPACE, "display"), 3 * p);
  return out;
}

interface Comparison {
  /** Pixels whose worst channel differs from the transcription by more than the tolerance. */
  off: number;
  worst: number;
  worstAt: string;
  /** Pixels one side replaced (by more than 1e-3) and the other did not. */
  disagree: number;
  changed: number;
}

function compare(gpu: Float32Array, ref: Float32Array, input: Float32Array, inside = (_x: number) => true): Comparison {
  const c: Comparison = { off: 0, worst: 0, worstAt: "", disagree: 0, changed: 0 };
  const fmt = (a: Float32Array, p: number) => [0, 1, 2].map((k) => a[3 * p + k].toFixed(4)).join(",");
  for (let p = 0; p < W * H; p++) {
    if (!inside(p % W)) continue;
    let d = 0;
    let gc = 0;
    let rc = 0;
    for (let k = 0; k < 3; k++) {
      d = Math.max(d, Math.abs(gpu[3 * p + k] - ref[3 * p + k]));
      gc = Math.max(gc, Math.abs(gpu[3 * p + k] - input[3 * p + k]));
      rc = Math.max(rc, Math.abs(ref[3 * p + k] - input[3 * p + k]));
    }
    if (d > TOLERANCE) c.off++;
    if (d > c.worst) {
      c.worst = d;
      c.worstAt = `(${p % W},${Math.floor(p / W)}) gpu ${fmt(gpu, p)} ref ${fmt(ref, p)} in ${fmt(input, p)}`;
    }
    if (rc > 1e-3) c.changed++;
    if (gc > 1e-3 !== rc > 1e-3) c.disagree++;
  }
  return c;
}

/** The stage cut short after `upto` passes, then w shown as grey. */
function dumpStage(upto: 3 | 4): ProcessingStageContribution {
  const base = impulseStage();
  const passes = (base.passes ?? []).slice(0, upto);
  passes.push({ channels: 4, glsl: "c = vec4(c.w, c.w, c.w, 0.0);", helpers: "", uniforms: [], iterations: { key: "enabled", max: 1 } });
  return { ...base, passes, glsl: "if (enabled != 0) { c = stageResult; }" } as ProcessingStageContribution;
}

describe("Impulse Noise Reduction on the GPU", () => {
  const bags: Record<string, Bag> = { idle: off };
  for (const t of THRESHOLDS) bags[`t${t}`] = on(t);
  const frames = render(bags);
  const input = linear(frames.idle);

  it("leaves the frame as it was while it is off", () => {
    const without = render({ idle: {} }, []).idle;
    let worst = 0;
    for (let i = 0; i < without.length; i++) worst = Math.max(worst, Math.abs(frames.idle[i] - without[i]) / Math.max(Math.abs(without[i]), 1e-6));
    expect(worst).toBeLessThan(UNTOUCHED);
  });

  it.each(THRESHOLDS)("matches RawTherapee's result at Threshold %i", (t) => {
    const ref = impulseDenoise(input, W, H, t, "rt");
    const c = compare(linear(frames[`t${t}`]), ref, input);
    console.log(
      `[inr-gpu] Threshold ${t}: ${c.changed} pixels changed; ${c.off} off by more than ${TOLERANCE}, ${c.disagree} replaced on one side only; worst ${c.worst.toExponential(2)} ${c.worstAt}`,
    );
    expect(c.changed).toBeGreaterThan(300);
    expect(c.disagree).toBeLessThanOrEqual(Math.ceil(c.changed * TIE_SHARE));
    expect(c.off).toBeLessThanOrEqual(Math.ceil(c.changed * TIE_SHARE));
  });

  it("leaves every pixel it does not replace exactly as it was, to the bit", () => {
    for (const t of [0, 50, 100]) {
      const got = frames[`t${t}`];
      const ref = impulseDenoise(input, W, H, t, "rt");
      let kept = 0;
      let moved = 0;
      for (let p = 0; p < W * H; p++) {
        let change = 0;
        for (let k = 0; k < 3; k++) change = Math.max(change, Math.abs(ref[3 * p + k] - input[3 * p + k]));
        if (change > 1e-4) continue;
        kept++;
        // A flag at a near-tie may still flip on the half-float side; those are counted.
        for (let k = 0; k < 3; k++) if (got[4 * p + k] !== frames.idle[4 * p + k]) { moved++; break; }
      }
      console.log(`[inr-gpu] Threshold ${t}: ${moved} of ${kept} untouched pixels are not bit-equal to the input`);
      expect(kept).toBeGreaterThan(W * H * 0.8);
      expect(moved).toBeLessThanOrEqual(Math.ceil(W * H * 5e-3));
    }
  });

  it("flags the pixels the transcription flags, and its high-pass is the transcription's", () => {
    for (const t of [0, 61, 100]) {
      const lab = rgbToLab(input, W * H);
      const ref = impulseFlags(lab, W, H, t / 20, "rt");
      const hp = linear(render({ on: on(t) }, [dumpStage(3)]).on);
      const flags = linear(render({ on: on(t) }, [dumpStage(4)]).on);
      let flips = 0;
      let worst = 0;
      for (let p = 0; p < W * H; p++) {
        if (Math.abs(flags[3 * p + 1] - ref.flags[p]) > 0.5) flips++;
        worst = Math.max(worst, Math.abs(hp[3 * p + 1] - ref.hp[p] / 32768));
      }
      console.log(`[inr-gpu] Threshold ${t}: ${flips} flags differ from the transcription's; high-pass worst ${worst.toExponential(2)} (of L* / 100)`);
      expect(flips).toBeLessThanOrEqual(Math.ceil(W * H * 5e-3));
      expect(worst).toBeLessThan(8e-4);
    }
  });

  it("replaces the corner, border and paired impulses", () => {
    const gpu = linear(frames.t50);
    const ref = impulseDenoise(input, W, H, 50, "rt");
    for (const [x, y] of FORCED) {
      const p = y * W + x;
      expect(Math.abs(ref[3 * p + 1] - input[3 * p + 1]), `transcription (${x},${y})`).toBeGreaterThan(0.02);
      expect(Math.abs(gpu[3 * p + 1] - ref[3 * p + 1]), `gpu (${x},${y})`).toBeLessThan(TOLERANCE);
    }
  });

  it("leaves a mask's outside as it was and treats the inside as the photo alone", () => {
    const mask: Mask = {
      id: "m",
      name: "Mask",
      visible: true,
      invert: false,
      opacity: 100,
      adj: defaultMaskAdjustments(),
      panels: ["impulse-noise-reduction.panel"],
      bag: on(80),
      components: [{ id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } }],
    };
    const got = linear(render({ masked: off }, undefined, SCENE, [mask]).masked);
    const ref = impulseDenoise(input, W, H, 80, "rt");
    for (let p = 0; p < W * H; p++) {
      if (p % W < W / 2 - 1) for (let k = 0; k < 3; k++) expect(Math.abs(got[3 * p + k] - input[3 * p + k])).toBeLessThan(OUTSIDE);
    }
    const c = compare(got, ref, input, (x) => x > W / 2 + 1);
    console.log(`[inr-gpu] masked Threshold 80: ${c.changed} pixels changed inside; ${c.off} off, worst ${c.worst.toExponential(2)}`);
    expect(c.changed).toBeGreaterThan(300);
    expect(c.off).toBeLessThanOrEqual(Math.ceil(c.changed * TIE_SHARE));
  });

  // A draw reads at most 65 texels; here the widest blur runs across a frame as wide as the default render.
  it("draws the widest blur across 4096 pixels and removes the impulses on it", () => {
    const wide = 4096;
    const high = 48;
    const image = floatImage(wide, high, (x, y) => {
      const v = 0.3 + 0.1 * Math.sin(x * 0.01) + 0.03 * (hash(x, y) - 0.5);
      return hash(x, y, 3) < 0.01 ? [0.92, 0.92, 0.92] : [v, v * 0.9, v * 0.8];
    });
    const t0 = performance.now();
    const frame = render({ wide: on(100) }, undefined, image).wide;
    const ms = performance.now() - t0;
    const out = linear(frame, wide * high);
    let impulses = 0;
    let left = 0;
    for (let p = 0; p < wide * high; p++) {
      if (hash(p % wide, Math.floor(p / wide), 3) >= 0.01) continue;
      impulses++;
      if (out[3 * p + 1] > 0.7) left++;
    }
    console.log(`[inr-gpu] 4096 x ${high} at Threshold 100: ${ms.toFixed(0)} ms for the five passes; ${left} of ${impulses} impulses left`);
    expect(impulses).toBeGreaterThan(1000);
    expect(left).toBeLessThan(impulses * 0.02);
  });
});
