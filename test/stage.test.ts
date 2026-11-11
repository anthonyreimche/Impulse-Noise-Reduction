// The stage contract the host relies on, and what a draw may cost. Unit tests
// can't run GLSL; the GPU spec (test/gpu) renders it.

import { describe, expect, it } from "vitest";
import { MAX_RADIUS, MAX_TAPS_PER_DRAW } from "../src/model";
import {
  BLUR_H_GLSL,
  BLUR_HELPERS,
  BLUR_V_GLSL,
  FLAG_GLSL,
  INLINE_GLSL,
  REPLACE_GLSL,
  START_GLSL,
  THRESHOLD_HELPERS,
  glslLiteral,
} from "../src/glsl";
import { LABELS } from "../src/params";
import { impulseStage } from "../src/stage";

const stage = impulseStage();
const passes = stage.passes ?? [];

describe("the stage", () => {
  it("reads the edited image in linear Rec. 709, in the display phase ahead of the sharpening stages", () => {
    expect(stage).toMatchObject({ phase: "display-adjust", reads: "current", space: { encoding: "linear", primaries: "rec709" } });
    expect(stage.priority).toBeLessThan(50);
  });

  it("runs five four-channel passes, one draw each while the switch is on and none while it is off", () => {
    expect(passes).toHaveLength(5);
    for (const p of passes) expect(p).toMatchObject({ channels: 4, iterations: { key: "enabled", max: 1 } });
  });

  it("declares both edit keys on the stage, for presets and paste, and the threshold again on the passes that read it", () => {
    expect(stage.uniforms.map((u) => u.key)).toEqual(["enabled", "threshold"]);
    // An int, not a bool: it is the passes' iterations key, which the host takes from an int or float uniform.
    expect(stage.uniforms[0]).toMatchObject({ glslType: "int", default: 0, range: { min: 0, max: 1 } });
    expect(stage.uniforms[1]).toMatchObject({ glslType: "int", default: 50, range: { min: 0, max: 100 } });
    const declared = passes.map((p) => p.uniforms?.map((u) => u.key) ?? []);
    expect(declared).toEqual([[], ["threshold"], ["threshold"], ["threshold"], []]);
    expect(passes[1].uniforms?.[0]).toMatchObject({ glslType: "int", default: 50, range: { min: 0, max: 100 } });
  });

  // The host builds preset and paste descriptors from the stage's own uniforms alone.
  it("declares every pass uniform on the stage too", () => {
    const onStage = stage.uniforms.map((u) => u.key);
    for (const p of passes) for (const u of p.uniforms ?? []) expect(onStage).toContain(u.key);
  });

  it("labels its uniforms as the panel does", () => {
    for (const u of stage.uniforms) expect(u.label).toBe(LABELS[u.key as keyof typeof LABELS]);
    expect(LABELS).toEqual({ enabled: "Enabled", threshold: "Threshold" });
  });

  it("is dormant while it is off", () => {
    expect(stage.dormantWhen).toEqual({ enabled: 0 });
  });

  it("changes nothing until the passes have drawn", () => {
    expect(INLINE_GLSL.trim().startsWith("if (enabled != 0) {")).toBe(true);
  });

  it("adds the change a replacement makes and never takes the pass result for the pixel", () => {
    expect(INLINE_GLSL).not.toMatch(/\bc\s*=\s*stageResult/);
    expect(INLINE_GLSL).toMatch(/\bc\s*\+=\s*change/);
  });

  it("can run inside masks", () => {
    expect(stage.mask).toEqual({ maskable: true });
  });

  it("names the threshold only in the passes that declare it", () => {
    for (const [i, p] of passes.entries()) {
      const declares = (p.uniforms ?? []).some((u) => u.key === "threshold");
      const reads = /\bthreshold\b/.test(`${p.glsl}${p.helpers ?? ""}`);
      expect(reads, `pass ${i}`).toBe(declares);
    }
    expect(/\bthreshold\b/.test(INLINE_GLSL + (stage.helpers ?? ""))).toBe(false);
  });
});

describe("a draw's cost", () => {
  const reads = (glsl: string) => (glsl.match(/fetchPrev4\(/g) ?? []).length;

  it("reads at most the widest blur's taps", () => {
    expect(MAX_RADIUS).toBe(24);
    expect(MAX_TAPS_PER_DRAW).toBe(49);
    // One read, in the line value that every call site of the window loops and the far-edge walk goes through.
    expect(reads(BLUR_HELPERS)).toBe(1);
    expect(BLUR_HELPERS).toContain(`for (int k = 1; k <= ${MAX_RADIUS}; k++) {
    if (k > f.radius) break;`);
    for (const glsl of [BLUR_H_GLSL, BLUR_V_GLSL]) {
      expect(reads(glsl)).toBe(0);
      expect(glsl).toContain("inrBlurLine(");
    }
    expect(BLUR_HELPERS).toContain(`radius = min(int(ceil(6.0 * sigma)), ${MAX_RADIUS});`);
  });

  it("reads the 5 x 5 block, 25 texels, in the flag and replacement draws", () => {
    for (const glsl of [FLAG_GLSL, REPLACE_GLSL]) {
      expect(reads(glsl)).toBe(1);
      expect(glsl).toContain("for (int dy = -2; dy <= 2; dy++)");
      expect(glsl).toContain("for (int dx = -2; dx <= 2; dx++)");
    }
    expect(reads(START_GLSL)).toBe(0);
  });

  it("clips the block to the frame and divides by 24 whatever the border leaves", () => {
    expect(FLAG_GLSL).toContain("if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;");
    expect(FLAG_GLSL).toContain("/ 24.0");
    expect(THRESHOLD_HELPERS).toContain("/ 20.0");
  });

  it("passes an untouched pixel through as it came, with no marker for a filtered read to leak", () => {
    expect(REPLACE_GLSL).toContain("vec4 keep = vec4(c.rgb, 0.0);");
    expect(INLINE_GLSL).not.toContain("stageResult.w");
  });

  it("writes float literals GLSL ES accepts", () => {
    expect(glslLiteral(1)).toBe("1.0");
    expect(glslLiteral(32768)).toBe("32768.0");
    expect(glslLiteral(-0.25)).toBe("-0.25");
    expect(Number(glslLiteral(216 / 24389))).toBeCloseTo(216 / 24389, 9);
    for (const glsl of [START_GLSL, BLUR_H_GLSL, BLUR_V_GLSL, FLAG_GLSL, REPLACE_GLSL, INLINE_GLSL]) {
      expect(glsl).not.toMatch(/[^\w.]\d+e-?\d/);
    }
  });

  it("names no GLSL built-in as a variable", () => {
    for (const name of ["step", "smooth", "filter", "active", "input", "output", "sample"]) {
      for (const glsl of [BLUR_H_GLSL, BLUR_V_GLSL, FLAG_GLSL, REPLACE_GLSL, BLUR_HELPERS]) {
        expect(glsl).not.toMatch(new RegExp(`\\b(int|float|vec2|vec4|ivec2)\\s+${name}\\b`));
      }
    }
  });
});
