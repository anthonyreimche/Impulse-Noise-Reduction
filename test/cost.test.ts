// What ANGLE's D3D11 back end makes slow or inexact, and the read budget of each draw. Unit tests can't run
// GLSL; they hold the generated source to the rules the hardware run found.

import { describe, expect, it } from "vitest";
import { BLOCK_RADIUS, MAX_RADIUS } from "../src/model";
import { impulseStage } from "../src/stage";

const stage = impulseStage();
const passes = (stage.passes ?? []).map((p, i) => ({ name: `pass ${i + 1}`, src: `${p.helpers ?? ""}\n${p.glsl}` }));
const inline = `${stage.helpers ?? ""}\n${stage.glsl}`;

describe("what ANGLE's D3D11 back end makes slow", () => {
  it("leaves the passes no constant arrays, which become a copy per pixel", () => {
    for (const { name, src } of passes) {
      expect([name, src.match(/\bconst\s+\w+\s+\w+\s*\[[^\]]*\]/g) ?? []]).toEqual([name, []]);
      expect([name, src.match(/\b(?:float|int|vec[234]|ivec[234])\s*\[\s*\d+\s*\]\s*\(/g) ?? []]).toEqual([name, []]);
    }
  });

  it("leaves them no local arrays, which a loop's index makes an indexable copy", () => {
    for (const { name, src } of passes) {
      const arrays = src.match(/\b(?:highp\s+|mediump\s+|out\s+|inout\s+|in\s+)*(?:bool|float|int|uint|vec[234]|ivec[234]|uvec[234])\s+[A-Za-z_]\w*\s*\[[^\]]*\]/g) ?? [];
      expect([name, arrays]).toEqual([name, []]);
    }
  });

  it("reads the previous draw by texel, never through a sampled read whose gradient flattens the dispatch", () => {
    for (const { name, src } of passes) {
      expect([name, src.match(/\b(?:readPrev4|readPrev|texture|textureLod|readSource)\s*\(/g) ?? []]).toEqual([name, []]);
    }
  });
});

describe("what ANGLE's D3D11 back end makes inexact", () => {
  it("rounds every store to the nearest half itself: D3D11 truncates toward 0 where SwiftShader rounds", () => {
    for (const { name, src } of passes) expect([name, /\bc = inrHalf4\(c\);\s*$/.test(src)]).toEqual([name, true]);
  });

  it("compares the inline's input to a nearest rounding too, not to packHalf2x16's", () => {
    expect(inline).not.toMatch(/packHalf2x16|unpackHalf2x16/);
    expect(inline).toContain("inrHalf");
    expect(stage.helpers).toContain("float inrHalfRound(");
  });
});

describe("the read budget", () => {
  const DRAW_BUDGET = 100;
  const reads = (glsl: string) => (glsl.match(/\b(?:fetchPrev4|inrLineValue)\(/g) ?? []).length;
  const blur = passes[1].src;

  it("keeps a blur draw to the line window plus the far-edge walk, at most 3 x the widest radius + 2 texels", () => {
    const sites = reads(blur.replace(/float inrLineValue[\s\S]*?\n}\n/, ""));
    // The centre, the pair in the window's loop, the edge pixel and the walk's one: 1 + 2R + 1 + R.
    expect(sites).toBe(5);
    expect(blur.match(/for \(int [ki] = 1; [ki] <= 24; [ki]\+\+\)/g)).toHaveLength(2);
    expect(1 + 2 * MAX_RADIUS + 1 + MAX_RADIUS).toBeLessThanOrEqual(DRAW_BUDGET);
  });

  it("keeps the flag and replacement draws to the 5 x 5 block", () => {
    const block = (2 * BLOCK_RADIUS + 1) ** 2;
    expect(block).toBe(25);
    for (const i of [3, 4]) expect(reads(passes[i].src)).toBe(1);
    expect(reads(passes[0].src)).toBe(0);
  });
});
