// RawTherapee 5.13's Impulse Noise Reduction (GPL-3.0-or-later):
//   rtengine/impulse_denoise.cc     © 2010 Emil Martinec <ejmartin@uchicago.edu>
//   rtengine/gauss.cc               © 2004-2010 Gabor Horvath <hgabor@rawtherapee.com>
// the parts the CPU needs:
// the tool's one setting and the numbers it derives from it. glsl.ts does the
// per-pixel work with the same arithmetic, so the two must agree.
//
// The tool lays a Gaussian low-pass over the lightness (gauss.cc's
// Young-van Vliet recursion), takes the absolute difference as the high-pass,
// flags a pixel whose high-pass beats a share of the 5x5 block's, and
// replaces a flagged pixel in lightness, a and b by an average of the block's
// unflagged pixels weighted by 1 / (lightness difference² + 1).

export interface Params {
  enabled: boolean;
  /** RawTherapee's Threshold, 0 to 100. */
  threshold: number;
}

export const DEFAULT_PARAMS: Readonly<Params> = { enabled: false, threshold: 50 };

export interface Range {
  min: number;
  max: number;
}

export const RANGES: Readonly<Record<"threshold", Range>> = { threshold: { min: 0, max: 100 } };

/** The GPU keeps lightness, a and b in RawTherapee's units (0 to 32768 for
 *  lightness) divided by this, so a half float holds them. */
export const STATE_SCALE = 32768;
/** RawTherapee's `eps`, in its units: the weight of a pixel is 1 / (ΔL² + eps). */
export const WEIGHT_EPSILON = 1;
/** The tool skips an image with a side under this. */
export const MIN_SIZE = 8;
/** The block the flags and the replacement look at: 5 x 5. */
export const BLOCK_RADIUS = 2;
/** The sharpest the blur gets: sigma at a threshold of 5 (Threshold 100). */
export const MAX_SIGMA = 4;
/** How many sigmas each side of the centre the blur is run. */
export const BLUR_REACH = 6;
/** Taps each side of the widest blur. */
export const MAX_RADIUS = BLUR_REACH * MAX_SIGMA;
/** The longest a draw reads: both sides of the widest blur and the middle tap. */
export const MAX_TAPS_PER_DRAW = 2 * MAX_RADIUS + 1;

/** The threshold the tool works with: Threshold over 20, after RawTherapee's
 *  own scaling of it with the size it processes at (simpleprocess.cc,
 *  adjust_procparams). A render never exceeds the source, so scale is at most 1. */
export function effectiveThreshold(threshold: number, scale: number): number {
  return (threshold * Math.min(scale, 1)) / 20;
}

/** The Gaussian's sigma, in pixels (impulse_nr: max(2, thresh - 1)). */
export function blurSigma(thresh: number): number {
  return Math.max(2, thresh - 1);
}

/** impthr / 24 (impulse_nr: impthr = max(1, 5.5 - thresh)), the share of the
 *  block's other high-pass values a pixel must beat. */
export function flagGain(thresh: number): number {
  return Math.max(1, 5.5 - thresh) / 24;
}

/** How far each side of the centre the blur is run: 6 sigma, past where the
 *  response has fallen under 1e-4 of the centre tap. */
export function kernelRadius(sigma: number): number {
  return Math.ceil(BLUR_REACH * sigma);
}

export interface RecursionCoefficients {
  B: number;
  b1: number;
  b2: number;
  b3: number;
}

/** gauss.cc calculateYvVFactors(): the recursion
 *  y[n] = B x[n] + b1 y[n-1] + b2 y[n-2] + b3 y[n-3]. */
export function yvvCoefficients(sigma: number): RecursionCoefficients {
  const q = sigma < 2.5 ? 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * sigma) : 0.98711 * sigma - 0.9633;
  const b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q * q * q;
  const b1 = 2.44413 * q + 2.85619 * q * q + 1.26661 * q * q * q;
  const b2 = -1.4281 * q * q - 1.26661 * q * q * q;
  const b3 = 0.422205 * q * q * q;
  return { B: 1 - (b1 + b2 + b3) / b0, b1: b1 / b0, b2: b2 / b0, b3: b3 / b0 };
}

/** How much further than an edge pixel carried on indefinitely the SSE routines
 *  (which the CLI runs) start the far end of a line: the ratio of their scaling of
 *  the boundary matrix to the plain routines'. Same as USM and RL Sharpening's. */
export function edgeFactor(sigma: number): number {
  const { b1, b2, b3 } = yvvCoefficients(sigma);
  const k = 1 + b2 + (b1 - b3) * b3;
  return (k * k) / (1 - b1 - b2 - b3);
}

/** The response of the recursion run forward and then backward, on one side of
 *  its centre (tap 0 is the centre), cut at kernelRadius and made to sum to 1.
 *  A clamped read of this symmetric kernel extends the edge pixel indefinitely,
 *  which is how gauss.cc's plain routines start the far end; the SSE routines
 *  the CLI runs differ there by edgeFactor, which the shader carries back.
 *
 *  The response g[k] = Σ h[n] h[n+k] of the causal response h is a sum of the
 *  recursion's modes, so it obeys the same recurrence for k >= 1, with g[-k] =
 *  g[k]. The first two terms follow from the recurrence at k = 1 and 2. */
export function blurTaps(sigma: number): Float64Array {
  const { b1, b2, b3 } = yvvCoefficients(sigma);
  const radius = kernelRadius(sigma);
  const g = new Float64Array(radius + 1);
  g[0] = 1;
  g[1] = (b1 + b2 * b3) / (1 - b2 - b1 * b3 - b3 * b3);
  g[2] = b2 + (b1 + b3) * g[1];
  for (let k = 3; k <= radius; k++) g[k] = b1 * g[k - 1] + b2 * g[k - 2] + b3 * g[k - 3];
  let sum = g[0];
  for (let k = 1; k <= radius; k++) sum += 2 * g[k];
  return g.map((v) => v / sum);
}
