import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  MAX_RADIUS,
  MAX_SIGMA,
  edgeFactor,
  RANGES,
  blurSigma,
  blurTaps,
  effectiveThreshold,
  flagGain,
  kernelRadius,
  yvvCoefficients,
} from "../src/model";

/** The impulse response of the Young-van Vliet filter RawTherapee's gaussianBlur
 *  runs for sigma 2 to 4: a causal and an anticausal third-order recursion in
 *  series, each of gain 1. Summed in double over a long enough stretch. */
function exactResponse(sigma: number, reach = 400): Float64Array {
  const { B, b1, b2, b3 } = yvvCoefficients(sigma);
  const h = new Float64Array(reach);
  for (let n = 0; n < reach; n++) {
    h[n] = (n === 0 ? B : 0) + b1 * (h[n - 1] ?? 0) + b2 * (h[n - 2] ?? 0) + b3 * (h[n - 3] ?? 0);
  }
  const g = new Float64Array(reach);
  for (let k = 0; k < reach; k++) for (let n = 0; n + k < reach; n++) g[k] += h[n] * h[n + k];
  return g;
}

describe("the threshold", () => {
  it("is RawTherapee's: 50 of 0 to 100, in twentieths", () => {
    expect(DEFAULT_PARAMS).toEqual({ enabled: false, threshold: 50 });
    expect(RANGES.threshold).toEqual({ min: 0, max: 100 });
    expect(effectiveThreshold(50, 1)).toBe(2.5);
    expect(effectiveThreshold(100, 1)).toBe(5);
    expect(effectiveThreshold(0, 1)).toBe(0);
  });

  it("scales with the render, as RawTherapee's own reduced-size processing does", () => {
    expect(effectiveThreshold(100, 0.5)).toBe(2.5);
    expect(effectiveThreshold(50, 2)).toBe(2.5); // a render never exceeds the source
  });

  it("blurs at sigma 2 until the threshold passes 3, then at the threshold less 1", () => {
    expect(blurSigma(0)).toBe(2);
    expect(blurSigma(2.5)).toBe(2);
    expect(blurSigma(3)).toBe(2);
    expect(blurSigma(3.5)).toBe(2.5);
    expect(blurSigma(5)).toBe(4);
    expect(MAX_SIGMA).toBe(4);
  });

  it("flags with a gain of max(1, 5.5 - threshold) over 24", () => {
    expect(flagGain(0)).toBeCloseTo(5.5 / 24, 12);
    expect(flagGain(2.5)).toBeCloseTo(3 / 24, 12);
    expect(flagGain(4.5)).toBeCloseTo(1 / 24, 12);
    expect(flagGain(5)).toBeCloseTo(1 / 24, 12);
  });
});

describe("the blur", () => {
  it("uses the Young-van Vliet coefficients, switching formula at sigma 2.5", () => {
    const a = yvvCoefficients(2);
    expect(a.B).toBeCloseTo(0.2273, 3);
    // The two formulas for q do not meet: the response steps at 2.5, as the source's does.
    expect(Math.abs(yvvCoefficients(2.4999).b1 - yvvCoefficients(2.5).b1)).toBeGreaterThan(0.01);
    // A filter of unit gain: B + b1 + b2 + b3 over b0 is 1 by construction.
    for (const sigma of [2, 3, 4]) {
      const c = yvvCoefficients(sigma);
      expect(c.B + c.b1 + c.b2 + c.b3).toBeCloseTo(1, 12);
    }
  });

  it("reaches 6 sigma on each side, at most 24 taps", () => {
    expect(kernelRadius(2)).toBe(12);
    expect(kernelRadius(2.5)).toBe(15);
    expect(kernelRadius(4)).toBe(24);
    expect(MAX_RADIUS).toBe(24);
  });

  it.each([2, 2.5, 3, 3.7, 4])("matches the filter's own impulse response at sigma %s", (sigma) => {
    const taps = blurTaps(sigma);
    const exact = exactResponse(sigma);
    expect(taps).toHaveLength(kernelRadius(sigma) + 1);
    let worst = 0;
    for (let k = 0; k < taps.length; k++) worst = Math.max(worst, Math.abs(taps[k] - exact[k]));
    // What is cut off past the reach is under 1e-4 a tap.
    expect(worst).toBeLessThan(1e-4);
    const total = taps[0] + 2 * taps.slice(1).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  // The routines the CLI runs start the far end of a line from a boundary matrix
  // scaled by (1 + b2 + (b1 - b3) b3) over the product of the sums the plain
  // routines divide by; the ratio of the two scalings is the factor the shader carries back.
  it.each([2, 2.5, 3, 4])("scales the far-edge start by the SSE routines' ratio to the plain ones at sigma %s", (sigma) => {
    const { b1, b2, b3 } = yvvCoefficients(sigma);
    const up = 1 + b2 + (b1 - b3) * b3;
    const sse = up / ((1 + b1 - b2 + b3) * (1 - b1 - b2 - b3));
    const plain = 1 / ((1 + b1 - b2 + b3) * up);
    expect(edgeFactor(sigma)).toBeCloseTo(sse / plain, 12);
    expect(edgeFactor(2)).toBeGreaterThan(1);
    expect(edgeFactor(4)).toBeLessThan(1);
  });

  it("is not a Gaussian: the recursion's response differs by about 3 % of the peak", () => {
    const sigma = 4;
    const taps = blurTaps(sigma);
    const gauss = Array.from({ length: taps.length }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
    const sum = gauss[0] + 2 * gauss.slice(1).reduce((a, b) => a + b, 0);
    const gap = Math.max(...taps.map((t, k) => Math.abs(t - gauss[k] / sum))) / taps[0];
    expect(gap).toBeGreaterThan(0.02);
  });
});
