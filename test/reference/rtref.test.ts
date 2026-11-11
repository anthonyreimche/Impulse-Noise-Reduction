// rtref.ts, the float32 transcription of RawTherapee's impulse noise reduction,
// held to rawtherapee-cli's own output (test/reference/rawtherapee.json, made
// by the reference rig's modules/rtimpulse/make_fixture.py), and its parts to
// what the source says.

import { describe, expect, it } from "vitest";
import fixture from "./rawtherapee.json";
import { impulseDenoise, labToRgb, rgbToLab, yvvBlur } from "./rtref";
import { blurTaps } from "../../src/model";

const decode = (b64: string): Float32Array => {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
};

const { width: W, height: H } = fixture;
const input = decode(fixture.input);
const identity = decode(fixture.identity);

describe("rawtherapee-cli's output", () => {
  it("is the input to the identity render's few parts in 10^5", () => {
    let worst = 0;
    for (let i = 0; i < input.length; i++) worst = Math.max(worst, Math.abs(identity[i] - input[i]));
    expect(worst).toBeLessThan(5e-5);
  });

  // The identity render's own drift cancels, as the rig does. Pixels whose flag
  // sits at a float rounding of the threshold may flip; they are counted, not hidden.
  it.each(fixture.cases.map((c) => [c.threshold, c.output] as const))("is matched at Threshold %i", (threshold, output) => {
    const want = decode(output);
    const got = impulseDenoise(input, W, H, threshold);
    let worst = 0;
    let off = 0;
    for (let p = 0; p < W * H; p++) {
      let pixel = 0;
      for (let c = 0; c < 3; c++) {
        const i = 3 * p + c;
        pixel = Math.max(pixel, Math.abs(got[i] + (identity[i] - input[i]) - want[i]));
      }
      worst = Math.max(worst, pixel);
      if (pixel > 1e-4) off++;
    }
    expect(off).toBe(0);
    expect(worst).toBeLessThan(1e-4);
  });

  it("changes the image more as the threshold rises past the point the blur widens", () => {
    const change = (t: number) => {
      const out = decode(fixture.cases.find((c) => c.threshold === t)?.output ?? "");
      let n = 0;
      for (let p = 0; p < W * H; p++) if (Math.abs(out[3 * p + 1] - identity[3 * p + 1]) > 1e-3) n++;
      return n;
    };
    expect(change(0)).toBeGreaterThan(0);
    // Threshold 100 has the smallest flag gain (1/24) but the widest blur.
    expect(change(100)).not.toBe(change(0));
  });
});

// The plain "clamp" boundary is an edge pixel carried on indefinitely. RawTherapee's own backward
// recursion starts from a boundary matrix its SSE routines scale differently
// from the plain ones, so its last pixels of the right and bottom edges are not
// that: the plain scaling is exact, as the first test shows, the SSE one is not.
describe("the edge approximation", () => {
  it("is an exact edge extension with the plain routines' scaling", () => {
    const n = 48;
    const noise = new Float32Array(n * n);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) noise[i] = (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const sigma of [2, 3, 4]) {
      const taps = blurTaps(sigma);
      const out = yvvBlur(noise, n, n, sigma, "clamp");
      const at = (i: number, j: number) => noise[Math.min(Math.max(i, 0), n - 1) * n + Math.min(Math.max(j, 0), n - 1)];
      let worst = 0;
      for (const [i, j] of [[n - 1, n - 1], [n - 1, 20], [20, n - 1], [n - 3, 5], [0, 0], [2, n - 2]]) {
        let want = 0;
        for (let a = -taps.length + 1; a < taps.length; a++) {
          let row = 0;
          for (let b = -taps.length + 1; b < taps.length; b++) row += taps[Math.abs(b)] * at(i + a, j + b);
          want += taps[Math.abs(a)] * row;
        }
        worst = Math.max(worst, Math.abs(want - out[i * n + j]));
      }
      // The taps stop at 6 sigma.
      expect(worst).toBeLessThan(1e-4);
    }
  });

  it("differs from the CLI's recursion only within 12 pixels of the right and bottom edges", () => {
    for (const { threshold } of fixture.cases) {
      const cli = impulseDenoise(input, W, H, threshold, "rt");
      const clamp = impulseDenoise(input, W, H, threshold, "clamp");
      let differ = 0;
      for (let p = 0; p < W * H; p++) {
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(cli[3 * p + k] - clamp[3 * p + k]));
        if (d <= 1e-4) continue;
        differ++;
        const edge = Math.min(W - 1 - (p % W), H - 1 - Math.floor(p / W));
        expect(edge, `Threshold ${threshold} pixel ${p % W},${Math.floor(p / W)}`).toBeLessThanOrEqual(12);
      }
      expect(differ).toBeLessThan(W * H * 0.02);
    }
  });
});

describe("the transcription", () => {
  it("takes linear RGB to RawTherapee's Lab and back to within float rounding", () => {
    const rgb = new Float32Array([0.5, 0.5, 0.5, 0.9, 0.1, 0.02, 0.003, 0.2, 0.8, 0, 0, 0, 0.18, 0.18, 0.18]);
    const lab = rgbToLab(rgb, 5);
    // Mid grey is L* 76.1 in these units, and neutral stays neutral.
    expect(lab.L[0] / 327.68).toBeCloseTo(76.07, 1);
    expect(Math.abs(lab.a[0])).toBeLessThan(40);
    expect(Math.abs(lab.b[0])).toBeLessThan(40);
    const back = labToRgb(lab, 5);
    for (let i = 0; i < rgb.length; i++) expect(back[i]).toBeCloseTo(rgb[i], 5);
  });

  it("blurs with the recursion's response away from the edges, and holds a constant line", () => {
    const sigma = 3;
    const n = 101;
    const delta = new Float32Array(n * n);
    delta[50 * n + 50] = 1;
    const out = yvvBlur(delta, n, n, sigma);
    const taps = blurTaps(sigma);
    for (const k of [0, 1, 2, 5, 9, 14]) {
      expect(out[50 * n + 50 + k]).toBeCloseTo(taps[0] * taps[k], 4);
      expect(out[(50 + k) * n + 50]).toBeCloseTo(taps[0] * taps[k], 4);
    }
    const flat = new Float32Array(n * n).fill(0.7);
    for (const v of yvvBlur(flat, n, n, sigma)) expect(v).toBeCloseTo(0.7, 6);
  });

  it("extends the edge pixel past the border, as a clamped read does", () => {
    const sigma = 2;
    const n = 40;
    const ramp = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) ramp[i * n + j] = j < 8 ? 1 : j === 8 ? 0.5 : 0;
    const out = yvvBlur(ramp, n, n, sigma);
    const taps = blurTaps(sigma);
    const at = (j: number) => ramp[Math.min(Math.max(j, 0), n - 1)];
    for (const j of [0, 1, 4, 20]) {
      let want = 0;
      for (let k = -(taps.length - 1); k < taps.length; k++) want += taps[Math.abs(k)] * at(j + k);
      expect(out[10 * n + j]).toBeCloseTo(want, 3);
    }
  });

  it("removes a lone impulse from a flat area and leaves the flat area alone", () => {
    const n = 24;
    const img = new Float32Array(n * n * 3).fill(0.3);
    const p = 12 * n + 12;
    img.set([0.9, 0.9, 0.9], 3 * p);
    const out = impulseDenoise(img, n, n, 50);
    expect(out[3 * p]).toBeCloseTo(0.3, 4);
    expect(out[3 * (p + 1)]).toBeCloseTo(0.3, 5);
  });

  it("leaves an image with a side under 8 pixels alone, to the Lab round trip", () => {
    const img = new Float32Array(7 * 20 * 3).fill(0.3);
    img[3 * 40] = 0.9;
    const out = impulseDenoise(img, 20, 7, 50);
    expect(out[3 * 40]).toBeCloseTo(0.9, 5);
  });
});
