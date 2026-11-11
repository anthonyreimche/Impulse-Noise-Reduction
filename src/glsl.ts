// The GPU side of model.ts: RawTherapee 5.13's impulse noise reduction
// (GPL-3.0-or-later):
//   rtengine/impulse_denoise.cc     © 2010 Emil Martinec <ejmartin@uchicago.edu>
//   rtengine/gauss.cc, color.cc, color.h, iccmatrices.h
//                                   © 2004-2010 Gabor Horvath <hgabor@rawtherapee.com>
//
// Five single-draw passes of four channels. The state is the pixel as it came,
// linear Rec.709 in rgb, and one working channel w. The targets are half
// floats, so nothing that needs precision is kept in w and every lightness is
// worked out again from rgb, which the half float holds exactly:
//
//   start    rgb as it came                                  w = 0
//   blur-h   the Gaussian low-pass of L along x             w = low-pass − L
//   blur-v   along y, then the high-pass                     w = |L − low-pass|
//   flag     the high-pass against a share of the 5x5 sum    w = 1 where flagged
//   replace  the weighted average of the unflagged pixels    rgb = the new pixel, or the old one
//
// w holds the low-pass as its difference from L (small, so its half-float
// rounding costs little) until the high-pass is taken in float.
//
// A pixel that is not replaced goes through the passes as it came, and the
// inline adds only the change a replacement makes, so the rest of the frame
// keeps its full precision. (A marker would not do: the host reads the last
// draw with a filtered fetch, which mixes in about 3e-5 of the neighbours, and
// a large marker value would leak into them.) The blur is gaussianBlur's
// recursion (a Young-van Vliet filter, forward then backward) written as the
// finite kernel it makes: its response obeys the recursion's own recurrence, so
// the taps come from the coefficients in a few multiplications per draw,
// whatever sigma the threshold asks for. Its far ends (right and bottom) start
// the way the SSE routines of gauss.cc do, as USM and RL Sharpening's blur does.
//
// Every lightness is recomputed from the half-float rgb, so a flag can still
// flip where its test sits within a rounding of the threshold; most such flips
// come from the half-float rgb the passes read, a few from the stored high-pass.

import { BLOCK_RADIUS, BLUR_REACH, MAX_RADIUS, MIN_SIZE, STATE_SCALE, WEIGHT_EPSILON } from "./model";

/** A GLSL float literal that always carries a decimal point. */
export function glslLiteral(v: number): string {
  const s = v.toPrecision(10);
  if (/e/i.test(s)) {
    const [mantissa, exponent] = s.split(/e/i);
    const m = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
    return `${m}e${Number(exponent)}`;
  }
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, ".0") : `${s}.0`;
}

const lit = glslLiteral;

// color.h: D50x and D50z, the epsilon and kappa of CIE Lab.
const D50X = 0.9642;
const D50Z = 0.8249;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
// iccmatrices.h: xyz_sRGB and sRGB_xyz, Rec.709 primaries adapted to D50.
const RGB_XYZ = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];
const XYZ_RGB = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
];

const row = (m: number[]) => `vec3(${m.map(lit).join(", ")})`;

/** Linear working RGB to RawTherapee's Lab / 32768 (lightness 0 to 1, a and b
 *  about ±1.3), and back: Color::XYZ2Lab and Lab2XYZ. */
export const COLOUR_HELPERS = `
float inrF(float t) { return t > ${lit(EPSILON)} ? pow(t, ${lit(1 / 3)}) : (${lit(KAPPA)} * t + 16.0) / 116.0; }
float inrFInv(float f) { return f > ${lit(6 / 29)} ? f * f * f : (116.0 * f - 16.0) / ${lit(KAPPA)}; }
float inrLightness(vec3 rgb) {
  float y = dot(${row(RGB_XYZ[1])}, rgb);
  return (y > ${lit(EPSILON)} ? 116.0 * inrF(y) - 16.0 : ${lit(KAPPA)} * y) * 0.01;
}
vec3 inrToState(vec3 rgb) {
  float x = dot(${row(RGB_XYZ[0])}, rgb) / ${lit(D50X)};
  float y = dot(${row(RGB_XYZ[1])}, rgb);
  float z = dot(${row(RGB_XYZ[2])}, rgb) / ${lit(D50Z)};
  float fx = inrF(x);
  float fy = inrF(y);
  float fz = inrF(z);
  float lightness = y > ${lit(EPSILON)} ? 116.0 * fy - 16.0 : ${lit(KAPPA)} * y;
  return vec3(lightness * 0.01, 5.0 * (fx - fy), 2.0 * (fy - fz));
}
vec3 inrFromState(vec3 lab) {
  float ll = lab.x * 100.0;
  float fy = (ll + 16.0) / 116.0;
  float fx = fy + 0.2 * lab.y;
  float fz = fy - 0.5 * lab.z;
  float x = inrFInv(fx) * ${lit(D50X)};
  float z = inrFInv(fz) * ${lit(D50Z)};
  float y = ll > 8.0 ? fy * fy * fy : ll / ${lit(KAPPA)};
  vec3 xyz = vec3(x, y, z);
  return vec3(dot(${row(XYZ_RGB[0])}, xyz), dot(${row(XYZ_RGB[1])}, xyz), dot(${row(XYZ_RGB[2])}, xyz));
}
`;

export const THRESHOLD_HELPERS = `
// Threshold / 20, scaled by how much smaller than the source this render is
// (simpleprocess.cc adjust_procparams scales the pp3's Threshold likewise).
float inrThresh() {
  vec2 size = floor(1.0 / uTexel + 0.5);
  float scale = min(max(size.x, size.y) / max(uSourceSize.x, uSourceSize.y), 1.0);
  return float(threshold) * scale / 20.0;
}
`;

/** The half-float quantizers. A pass ends with c = inrHalf4(c): an RGBA16F store rounds to nearest on
 *  SwiftShader but toward 0 through ANGLE's D3D11 back end (as packHalf2x16 does there), and a value
 *  that is already a half stores exactly on both. */
export const HALF_GLSL = `
float inrUlp(float v) {
  highp int e = ((floatBitsToInt(v) >> 23) & 255) - 127;
  return intBitsToFloat((max(e - 10, -24) + 127) << 23);
}
float inrHalfRound(float v) {
  float x = clamp(v, -65504.0, 65504.0);
  float q = inrUlp(x);
  return roundEven(x / q) * q;
}
vec3 inrHalf3(vec3 v) { return vec3(inrHalfRound(v.x), inrHalfRound(v.y), inrHalfRound(v.z)); }
vec4 inrHalf4(vec4 v) { return vec4(inrHalf3(v.xyz), inrHalfRound(v.w)); }
`;

/** The blur's taps for the render's threshold: gauss.cc calculateYvVFactors,
 *  then the response's recurrence (model.ts blurTaps). The far-edge factor rho
 *  is the SSE routines' start of the backward recursion over the plain ones'
 *  (model.ts edgeFactor). The taps are never held: a window of three
 *  consecutive ones walks outward by the recurrence itself, each divided by the
 *  sum of the unnormalised response, which the first walk finds. */
export const BLUR_HELPERS = `
struct InrFilter {
  int radius;
  float b1;
  float b2;
  float b3;
  float rho;
  float norm;
  float u1;
  float u2;
};

InrFilter inrFilter() {
  InrFilter f;
  float sigma = max(2.0, inrThresh() - 1.0);
  float q = sigma < 2.5 ? 3.97156 - 4.14554 * sqrt(1.0 - 0.26891 * sigma) : 0.98711 * sigma - 0.9633;
  float q2 = q * q;
  float q3 = q2 * q;
  float b0 = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
  f.b1 = (2.44413 * q + 2.85619 * q2 + 1.26661 * q3) / b0;
  f.b2 = (-1.4281 * q2 - 1.26661 * q3) / b0;
  f.b3 = 0.422205 * q3 / b0;
  float up = 1.0 + f.b2 + (f.b1 - f.b3) * f.b3;
  f.rho = up * up / (1.0 - f.b1 - f.b2 - f.b3);
  f.radius = min(int(ceil(${BLUR_REACH}.0 * sigma)), ${MAX_RADIUS});
  f.u1 = (f.b1 + f.b2 * f.b3) / (1.0 - f.b2 - f.b1 * f.b3 - f.b3 * f.b3);
  f.u2 = f.b2 + (f.b1 + f.b3) * f.u1;
  float t0 = 1.0;
  float t1 = f.u1;
  float t2 = f.u2;
  float sum = 1.0 + 2.0 * (t1 + t2);
  for (int k = 3; k <= ${MAX_RADIUS}; k++) {
    if (k > f.radius) break;
    float next = f.b1 * t2 + f.b2 * t1 + f.b3 * t0;
    t0 = t1;
    t1 = t2;
    t2 = next;
    sum += 2.0 * next;
  }
  f.norm = sum;
  return f;
}

// What the line being blurred holds at a texel: the lightness, and in the
// second blur the first blur's result on top of it.
float inrLineValue(ivec2 p, ivec2 size, bool second) {
  vec4 t = fetchPrev4(clamp(p, ivec2(0), size - 1));
  return inrLightness(t.rgb) + (second ? t.w : 0.0);
}

// The blur of a line along e (n texels long, this one the j-th) less this
// texel's own value. The taps read the edge pixel past either end, which is
// what the plain routines of gauss.cc do. The SSE routines the CLI runs start
// the backward recursion from a boundary matrix scaled by rho more, so the
// last texels differ: the difference at the three texels past the edge is
// worked out from the edge pixel and carried back by the recursion's own
// (homogeneous) step, as USM and RL Sharpening does. Those three sums take the
// edge pixel for every offset from the edge on, and the texels before it
// once each, against the taps i, i + 1 and i + 2 of the window at i.
float inrBlurLine(ivec2 q, ivec2 e, int n, int j, float own, bool second) {
  InrFilter f = inrFilter();
  ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
  float w0 = 1.0;
  float w1 = f.u1;
  float w2 = f.u2;
  float acc = w0 / f.norm * (inrLineValue(q, size, second) - own);
  for (int k = 1; k <= ${MAX_RADIUS}; k++) {
    if (k > f.radius) break;
    float next = f.b1 * w2 + f.b2 * w1 + f.b3 * w0;
    w0 = w1;
    w1 = w2;
    w2 = next;
    acc += w0 / f.norm * ((inrLineValue(q + e * k, size, second) - own) + (inrLineValue(q - e * k, size, second) - own));
  }
  int d = n - 1 - j;
  if (d <= f.radius) {
    float edge = inrLineValue(q + e * d, size, second) - own;
    w0 = 1.0;
    w1 = f.u1;
    w2 = f.u2;
    float head = w0 / f.norm;
    float y0 = 0.0;
    float y1 = 0.0;
    float y2 = 0.0;
    for (int i = 1; i <= ${MAX_RADIUS}; i++) {
      if (i > f.radius) break;
      float next = f.b1 * w2 + f.b2 * w1 + f.b3 * w0;
      w0 = w1;
      w1 = w2;
      w2 = next;
      float v = inrLineValue(q + e * (d - i), size, second) - own;
      head += w0 / f.norm;
      y0 += w0 / f.norm * v;
      y1 += (i + 1 > f.radius ? 0.0 : w1) / f.norm * v;
      y2 += (i + 2 > f.radius ? 0.0 : w2) / f.norm * v;
    }
    float t1 = f.u1 / f.norm;
    float t2 = f.u2 / f.norm;
    float c0 = (f.rho - 1.0) * (y0 + edge * head - edge);
    float c1 = (f.rho - 1.0) * (y1 + edge * (head + t1) - edge);
    float c2 = (f.rho - 1.0) * (y2 + edge * (head + t1 + t2) - edge);
    for (int t = 0; t < ${MAX_RADIUS}; t++) {
      if (t >= d) break;
      float next = f.b1 * c0 + f.b2 * c1 + f.b3 * c2;
      c2 = c1;
      c1 = c0;
      c0 = next;
    }
    acc += c0;
  }
  return acc;
}
`;

export const START_GLSL = `
c.w = 0.0;
c = inrHalf4(c);
`;

export const BLUR_H_GLSL = `
ivec2 q = ivec2(gl_FragCoord.xy);
ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
c.w = inrBlurLine(q, ivec2(1, 0), size.x, q.x, inrLightness(c.rgb), false);
c = inrHalf4(c);
`;

export const BLUR_V_GLSL = `
ivec2 q = ivec2(gl_FragCoord.xy);
ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
// The line holds lightness plus the first blur, so the high-pass is taken
// against the lightness alone: the first blur's w is added back.
float lowH = c.w;
float own = inrLightness(c.rgb) + lowH;
c.w = abs(inrBlurLine(q, ivec2(0, 1), size.y, q.y, own, true) + lowH);
c = inrHalf4(c);
`;

export const FLAG_GLSL = `
ivec2 q = ivec2(gl_FragCoord.xy);
ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
float gain = max(1.0, 5.5 - inrThresh()) / 24.0;
float total = 0.0;
for (int dy = -${BLOCK_RADIUS}; dy <= ${BLOCK_RADIUS}; dy++) {
  for (int dx = -${BLOCK_RADIUS}; dx <= ${BLOCK_RADIUS}; dx++) {
    ivec2 p = q + ivec2(dx, dy);
    if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;
    total += fetchPrev4(p).w;
  }
}
c.w = c.w > (total - c.w) * gain ? 1.0 : 0.0;
c = inrHalf4(c);
`;

export const REPLACE_GLSL = `
ivec2 q = ivec2(gl_FragCoord.xy);
ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
vec4 keep = vec4(c.rgb, 0.0);
if (size.x < ${MIN_SIZE} || size.y < ${MIN_SIZE} || c.w < 0.5) {
  c = keep;
} else {
  float centre = inrLightness(c.rgb);
  float norm = 0.0;
  vec3 sum = vec3(0.0);
  for (int dy = -${BLOCK_RADIUS}; dy <= ${BLOCK_RADIUS}; dy++) {
    for (int dx = -${BLOCK_RADIUS}; dx <= ${BLOCK_RADIUS}; dx++) {
      ivec2 p = q + ivec2(dx, dy);
      if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;
      vec4 n = fetchPrev4(p);
      if (n.w > 0.5) continue;
      vec3 lab = inrToState(n.rgb);
      float d = (lab.x - centre) * ${lit(STATE_SCALE)};
      float w = 1.0 / (d * d + ${lit(WEIGHT_EPSILON)});
      sum += w * lab;
      norm += w;
    }
  }
  c = norm > 0.0 ? vec4(inrFromState(sum / norm), 0.0) : keep;
}
c = inrHalf4(c);
`;

// Only the change goes on. A pixel the passes did not replace comes back as the
// nearest half float, which the passes' own rounding gives it too, so a
// difference within 0.2 % of the value, in every channel, is no replacement and adds
// nothing: the rest of the frame keeps its full precision. A replaced pixel
// is an outlier set to its neighbours' average, far beyond that.
export const INLINE_GLSL = `
if (enabled != 0) {
  vec3 change = stageResult - inrHalf3(c);
  if (any(greaterThan(abs(change), abs(c) * 0.002 + 0.000001))) {
    c += change;
  }
}
`;
