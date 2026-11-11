// A float32 transcription of RawTherapee 5.13's impulse noise reduction
// (GPL-3.0-or-later), with the source's loops, borders and rounding:
//   rtengine/impulse_denoise.cc impulse_nr   © 2010 Emil Martinec <ejmartin@uchicago.edu>
//   rtengine/gauss.cc (the Young-van Vliet blur), color.cc and color.h (the Lab
//   conversions), iccmatrices.h (the "sRGB" working matrix)
//                                            © 2004-2010 Gabor Horvath <hgabor@rawtherapee.com>
// It shares nothing with src/ but the licence: the GPU spec and
// the fixture test hold both to it. rtref.test.ts pins it to rawtherapee-cli.
//
// RawTherapee's units: working RGB 0..65535, Lab with L 0..32768 (L* times
// 327.68), a and b in the same units. The input and output here are linear
// Rec.709 in 0..1, the working space of the "sRGB" profile.

const f = Math.fround;

const MAXVAL = 65535;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const D50X = f(0.9642);
const D50Z = f(0.8249);
const EPS_MAX = MAXVAL * EPS;

// iccmatrices.h: xyz_sRGB and sRGB_xyz (Bradford, D50).
const RGB_XYZ = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
].map((row) => row.map(f));
const XYZ_RGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
];

/** Color::computeXYZ2Lab: the cube-root curve of x and z, and of y for a and b. */
function labF(v: number): number {
  if (v < 0) return f(327.68 * ((KAPPA * v) / MAXVAL + 16) / 116);
  if (v > MAXVAL) return f(327.68 * Math.cbrt(v / MAXVAL));
  return f(v <= EPS_MAX ? 327.68 * ((KAPPA * v) / MAXVAL + 16) / 116 : 327.68 * Math.cbrt(v / MAXVAL));
}

/** Color::computeXYZ2LabY: lightness from Y. */
function labL(v: number): number {
  if (v < 0) return f(327.68 * ((KAPPA * v) / MAXVAL));
  if (v > MAXVAL) return f(327.68 * (116 * Math.cbrt(v / MAXVAL) - 16));
  return f(v <= EPS_MAX ? 327.68 * ((KAPPA * v) / MAXVAL) : 327.68 * (116 * Math.cbrt(v / MAXVAL) - 16));
}

export interface Lab {
  L: Float32Array;
  a: Float32Array;
  b: Float32Array;
}

/** ImProcFunctions::rgb2lab from linear working RGB in 0..1. */
export function rgbToLab(rgb: Float32Array, count: number): Lab {
  const L = new Float32Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = f(rgb[3 * i] * MAXVAL);
    const g = f(rgb[3 * i + 1] * MAXVAL);
    const bl = f(rgb[3 * i + 2] * MAXVAL);
    const X = f(f(f(RGB_XYZ[0][0] * r) + f(RGB_XYZ[0][1] * g)) + f(RGB_XYZ[0][2] * bl));
    const Y = f(f(f(RGB_XYZ[1][0] * r) + f(RGB_XYZ[1][1] * g)) + f(RGB_XYZ[1][2] * bl));
    const Z = f(f(f(RGB_XYZ[2][0] * r) + f(RGB_XYZ[2][1] * g)) + f(RGB_XYZ[2][2] * bl));
    const fx = labF(f(X / D50X));
    const fy = labF(Y);
    const fz = labF(f(Z / D50Z));
    L[i] = labL(Y);
    a[i] = f(500 * f(fx - fy));
    b[i] = f(200 * f(fy - fz));
  }
  return { L, a, b };
}

/** Color::f2xyz */
const f2xyz = (v: number): number => (v > 6 / 29 ? f(f(v * v) * v) : f(f(116 * v - 16) * f(27 / 24389)));

/** Lab2XYZ and xyz2rgb, back to linear working RGB in 0..1. */
export function labToRgb(lab: Lab, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const LL = f(lab.L[i] / f(327.68));
    const aa = f(lab.a[i] / f(327.68));
    const bb = f(lab.b[i] / f(327.68));
    const fy = f(f(f(1 / 116) * LL) + f(16 / 116));
    const fx = f(f(0.002 * aa) + fy);
    const fz = f(fy - f(0.005 * bb));
    const x = f(f(f(MAXVAL * f2xyz(fx)) * D50X));
    const z = f(f(f(MAXVAL * f2xyz(fz)) * D50Z));
    const y = LL > 8 ? f(f(f(MAXVAL * fy) * fy) * fy) : f(f(MAXVAL * LL) / f(KAPPA));
    for (let c = 0; c < 3; c++) {
      out[3 * i + c] = f((XYZ_RGB[c][0] * x + XYZ_RGB[c][1] * y + XYZ_RGB[c][2] * z) / MAXVAL);
    }
  }
  return out;
}

interface Recursion {
  B: number;
  b1: number;
  b2: number;
  b3: number;
  M: number[][];
}

/** How the far end (right, bottom) of a line starts the backward recursion.
 *  "rt": the matrix as gaussHorizontalSse and gaussVerticalSse, which the CLI
 *  runs, scale it: not the edge pixel carried on indefinitely. "clamp": the
 *  scaling of the plain gaussHorizontal and gaussVertical (and of the
 *  Triggs-Sdika paper), which is exactly that. */
export type Boundary = "rt" | "clamp";

/** gauss.cc calculateYvVFactors, with the boundary matrix scaled as the chosen routines do. */
function recursion(sigma: number, boundary: Boundary): Recursion {
  const q = sigma < 2.5 ? 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * sigma) : 0.98711 * sigma - 0.9633;
  const b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q * q * q;
  let b1 = 2.44413 * q + 2.85619 * q * q + 1.26661 * q * q * q;
  let b2 = -1.4281 * q * q - 1.26661 * q * q * q;
  let b3 = 0.422205 * q * q * q;
  const B = 1 - (b1 + b2 + b3) / b0;
  b1 /= b0;
  b2 /= b0;
  b3 /= b0;
  const M = [
    [-b3 * b1 + 1 - b3 * b3 - b2, (b3 + b1) * (b2 + b3 * b1), b3 * (b1 + b3 * b2)],
    [b1 + b3 * b2, -(b2 - 1) * (b2 + b3 * b1), -(b3 * b1 + b3 * b3 + b2 - 1) * b3],
    [
      b3 * b1 + b2 + b1 * b1 - b2 * b2,
      b1 * b2 + b3 * b2 * b2 - b1 * b3 * b3 - b3 * b3 * b3 - b3 * b2 + b3,
      b3 * (b1 + b3 * b2),
    ],
  ];
  const up = 1 + b2 + (b1 - b3) * b3;
  const scale = boundary === "rt" ? up / ((1 + b1 - b2 + b3) * (1 - b1 - b2 - b3)) : 1 / ((1 + b1 - b2 + b3) * up);
  return { B, b1, b2, b3, M: M.map((row) => row.map((v) => v * scale)) };
}

/** One line of gaussHorizontal / gaussVertical: forward, then backward, with
 *  the Triggs-Sdika boundary at the far end. `get` and `put` address the line. */
function blurLine(n: number, get: (j: number) => number, put: (j: number, v: number) => void, r: Recursion): void {
  const { B, b1, b2, b3, M } = r;
  const t = new Float64Array(n);
  const s0 = get(0);
  t[0] = B * s0 + b1 * s0 + b2 * s0 + b3 * s0;
  t[1] = B * get(1) + b1 * t[0] + b2 * s0 + b3 * s0;
  t[2] = B * get(2) + b1 * t[1] + b2 * t[0] + b3 * s0;
  for (let j = 3; j < n; j++) t[j] = B * get(j) + b1 * t[j - 1] + b2 * t[j - 2] + b3 * t[j - 3];
  const e = get(n - 1);
  const edge = (m: number[]) => e + m[0] * (t[n - 1] - e) + m[1] * (t[n - 2] - e) + m[2] * (t[n - 3] - e);
  const tm1 = edge(M[0]);
  const t0 = edge(M[1]);
  const tp1 = edge(M[2]);
  t[n - 1] = tm1;
  t[n - 2] = B * t[n - 2] + b1 * t[n - 1] + b2 * t0 + b3 * tp1;
  t[n - 3] = B * t[n - 3] + b1 * t[n - 2] + b2 * t[n - 1] + b3 * t0;
  for (let j = n - 4; j >= 0; j--) t[j] = B * t[j] + b1 * t[j + 1] + b2 * t[j + 2] + b3 * t[j + 3];
  for (let j = 0; j < n; j++) put(j, t[j]);
}

/** gaussianBlur for sigma 2 to 4: gaussHorizontal then gaussVertical. */
export function yvvBlur(src: Float32Array, W: number, H: number, sigma: number, boundary: Boundary = "rt"): Float32Array {
  const r = recursion(sigma, boundary);
  const tmp = new Float32Array(W * H);
  for (let i = 0; i < H; i++) blurLine(W, (j) => src[i * W + j], (j, v) => void (tmp[i * W + j] = v), r);
  const out = new Float32Array(W * H);
  for (let j = 0; j < W; j++) blurLine(H, (i) => tmp[i * W + j], (i, v) => void (out[i * W + j] = v), r);
  return out;
}

/** impulse_nr's flags, and how close each pixel's test came: the high-pass over
 *  the share it must beat (above 1 is flagged). */
export function impulseFlags(lab: Lab, W: number, H: number, thresh: number, boundary: Boundary = "rt"): { flags: Uint8Array; ratio: Float32Array; hp: Float32Array } {
  const lpf = yvvBlur(lab.L, W, H, Math.max(2, thresh - 1), boundary);
  const impthrDiv24 = f(f(Math.max(1, 5.5 - thresh)) / 24);
  const flags = new Uint8Array(W * H);
  const ratio = new Float32Array(W * H);
  const hpAll = new Float32Array(W * H);
  const hp = (i: number, j: number) => f(Math.abs(f(lab.L[i * W + j] - lpf[i * W + j])));
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      const hpfabs = hp(i, j);
      hpAll[i * W + j] = hpfabs;
      let sum = 0;
      for (let i1 = Math.max(0, i - 2); i1 <= Math.min(i + 2, H - 1); i1++) {
        for (let j1 = Math.max(0, j - 2); j1 <= Math.min(j + 2, W - 1); j1++) sum = f(sum + hp(i1, j1));
      }
      const share = f(f(sum - hpfabs) * impthrDiv24);
      flags[i * W + j] = hpfabs > share ? 1 : 0;
      ratio[i * W + j] = share > 0 ? hpfabs / share : hpfabs > 0 ? Infinity : 0;
    }
  }
  return { flags, ratio, hp: hpAll };
}

/** ImProcFunctions::impulse_nr, in place. `thresh` is Threshold / 20. */
export function impulseNr(lab: Lab, W: number, H: number, thresh: number, boundary: Boundary = "rt"): void {
  const lpf = yvvBlur(lab.L, W, H, Math.max(2, thresh - 1), boundary);
  const impthrDiv24 = f(f(Math.max(1, 5.5 - thresh)) / 24);
  const impish = new Uint8Array(W * H);
  const hp = (i: number, j: number) => f(Math.abs(f(lab.L[i * W + j] - lpf[i * W + j])));
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      const hpfabs = hp(i, j);
      let sum = 0;
      for (let i1 = Math.max(0, i - 2); i1 <= Math.min(i + 2, H - 1); i1++) {
        for (let j1 = Math.max(0, j - 2); j1 <= Math.min(j + 2, W - 1); j1++) sum = f(sum + hp(i1, j1));
      }
      impish[i * W + j] = hpfabs > f(f(sum - hpfabs) * impthrDiv24) ? 1 : 0;
    }
  }
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      if (!impish[i * W + j]) continue;
      let norm = 0;
      let sL = 0;
      let sa = 0;
      let sb = 0;
      const centre = lab.L[i * W + j];
      for (let i1 = Math.max(0, i - 2); i1 <= Math.min(i + 2, H - 1); i1++) {
        for (let j1 = Math.max(0, j - 2); j1 <= Math.min(j + 2, W - 1); j1++) {
          const k = i1 * W + j1;
          if (impish[k]) continue;
          const d = f(lab.L[k] - centre);
          const w = f(1 / f(f(d * d) + 1));
          sL = f(sL + f(w * lab.L[k]));
          sa = f(sa + f(w * lab.a[k]));
          sb = f(sb + f(w * lab.b[k]));
          norm = f(norm + w);
        }
      }
      if (norm) {
        lab.L[i * W + j] = f(sL / norm);
        lab.a[i * W + j] = f(sa / norm);
        lab.b[i * W + j] = f(sb / norm);
      }
    }
  }
}

/** The tool as simpleprocess runs it: the image to Lab, impulsedenoise() (skipped
 *  below 8 pixels on a side), and back. `threshold` is the pp3's 0..100. */
export function impulseDenoise(rgb: Float32Array, W: number, H: number, threshold: number, boundary: Boundary = "rt"): Float32Array {
  const lab = rgbToLab(rgb, W * H);
  if (W >= 8 && H >= 8) impulseNr(lab, W, H, threshold / 20, boundary);
  return labToRgb(lab, W * H);
}
