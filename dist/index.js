//#region src/model.ts
var e = {
	enabled: !1,
	threshold: 50
}, t = { threshold: {
	min: 0,
	max: 100
} }, n = 32768, r = "impulse-noise-reduction", i = `${r}.denoise`, a = "Impulse Noise Reduction", o = {
	enabled: "Enabled",
	threshold: "Threshold"
}, s = (e) => `${a}: ${o[e]}`, c = `${a} reset`, l = ["enabled", "threshold"], u = (e) => `${i}.${e}`, d = (e) => typeof e == "number" && Number.isFinite(e);
function f(n) {
	let r = n[u("enabled")], i = n[u("threshold")];
	return {
		enabled: d(r) ? r !== 0 : e.enabled,
		threshold: d(i) ? Math.min(Math.max(Math.round(i), t.threshold.min), t.threshold.max) : e.threshold
	};
}
function p(e) {
	return {
		[u("enabled")]: +!!e.enabled,
		[u("threshold")]: e.threshold
	};
}
var m = () => p(e), h, g;
function _(e) {
	g = e, h = e.react;
}
//#endregion
//#region src/Panel.tsx
function v() {
	let { Slider: n } = g.components, { Stack: r, Toggle: i } = g.ui, a = g.develop.useParamScope(), c = f(a.getParams()), l = (e) => a.setParams(p({
		...f(a.getParams()),
		...e
	}));
	return /* @__PURE__ */ h.createElement(r, {
		gap: 6,
		style: { padding: 8 }
	}, /* @__PURE__ */ h.createElement(i, {
		label: o.enabled,
		checked: c.enabled,
		onChange: (e) => {
			l({ enabled: e }), a.commit(s("enabled"));
		}
	}), /* @__PURE__ */ h.createElement(n, {
		label: o.threshold,
		value: c.threshold,
		min: t.threshold.min,
		max: t.threshold.max,
		step: 1,
		defaultValue: e.threshold,
		onChange: (e) => l({ threshold: e }),
		onCommit: () => a.commit(s("threshold"))
	}));
}
//#endregion
//#region src/glsl.ts
function y(e) {
	let t = e.toPrecision(10);
	if (/e/i.test(t)) {
		let [e, n] = t.split(/e/i);
		return `${e.includes(".") ? e : `${e}.0`}e${Number(n)}`;
	}
	return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, ".0") : `${t}.0`;
}
var b = y, x = .9642, S = .8249, C = 216 / 24389, w = 24389 / 27, T = [
	[
		.4360747,
		.3850649,
		.1430804
	],
	[
		.2225045,
		.7168786,
		.0606169
	],
	[
		.0139322,
		.0971045,
		.7141733
	]
], E = [
	[
		3.1338561,
		-1.6168667,
		-.4906146
	],
	[
		-.9787684,
		1.9161415,
		.033454
	],
	[
		.0719453,
		-.2289914,
		1.4052427
	]
], D = (e) => `vec3(${e.map(b).join(", ")})`, O = `
float inrF(float t) { return t > ${b(C)} ? pow(t, ${b(1 / 3)}) : (${b(w)} * t + 16.0) / 116.0; }
float inrFInv(float f) { return f > ${b(6 / 29)} ? f * f * f : (116.0 * f - 16.0) / ${b(w)}; }
float inrLightness(vec3 rgb) {
  float y = dot(${D(T[1])}, rgb);
  return (y > ${b(C)} ? 116.0 * inrF(y) - 16.0 : ${b(w)} * y) * 0.01;
}
vec3 inrToState(vec3 rgb) {
  float x = dot(${D(T[0])}, rgb) / ${b(x)};
  float y = dot(${D(T[1])}, rgb);
  float z = dot(${D(T[2])}, rgb) / ${b(S)};
  float fx = inrF(x);
  float fy = inrF(y);
  float fz = inrF(z);
  float lightness = y > ${b(C)} ? 116.0 * fy - 16.0 : ${b(w)} * y;
  return vec3(lightness * 0.01, 5.0 * (fx - fy), 2.0 * (fy - fz));
}
vec3 inrFromState(vec3 lab) {
  float ll = lab.x * 100.0;
  float fy = (ll + 16.0) / 116.0;
  float fx = fy + 0.2 * lab.y;
  float fz = fy - 0.5 * lab.z;
  float x = inrFInv(fx) * ${b(x)};
  float z = inrFInv(fz) * ${b(S)};
  float y = ll > 8.0 ? fy * fy * fy : ll / ${b(w)};
  vec3 xyz = vec3(x, y, z);
  return vec3(dot(${D(E[0])}, xyz), dot(${D(E[1])}, xyz), dot(${D(E[2])}, xyz));
}
`, k = "\n// Threshold / 20, scaled by how much smaller than the source this render is\n// (simpleprocess.cc adjust_procparams scales the pp3's Threshold likewise).\nfloat inrThresh() {\n  vec2 size = floor(1.0 / uTexel + 0.5);\n  float scale = min(max(size.x, size.y) / max(uSourceSize.x, uSourceSize.y), 1.0);\n  return float(threshold) * scale / 20.0;\n}\n", A = "\nfloat inrUlp(float v) {\n  highp int e = ((floatBitsToInt(v) >> 23) & 255) - 127;\n  return intBitsToFloat((max(e - 10, -24) + 127) << 23);\n}\nfloat inrHalfRound(float v) {\n  float x = clamp(v, -65504.0, 65504.0);\n  float q = inrUlp(x);\n  return roundEven(x / q) * q;\n}\nvec3 inrHalf3(vec3 v) { return vec3(inrHalfRound(v.x), inrHalfRound(v.y), inrHalfRound(v.z)); }\nvec4 inrHalf4(vec4 v) { return vec4(inrHalf3(v.xyz), inrHalfRound(v.w)); }\n", j = "\nstruct InrFilter {\n  int radius;\n  float b1;\n  float b2;\n  float b3;\n  float rho;\n  float norm;\n  float u1;\n  float u2;\n};\n\nInrFilter inrFilter() {\n  InrFilter f;\n  float sigma = max(2.0, inrThresh() - 1.0);\n  float q = sigma < 2.5 ? 3.97156 - 4.14554 * sqrt(1.0 - 0.26891 * sigma) : 0.98711 * sigma - 0.9633;\n  float q2 = q * q;\n  float q3 = q2 * q;\n  float b0 = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;\n  f.b1 = (2.44413 * q + 2.85619 * q2 + 1.26661 * q3) / b0;\n  f.b2 = (-1.4281 * q2 - 1.26661 * q3) / b0;\n  f.b3 = 0.422205 * q3 / b0;\n  float up = 1.0 + f.b2 + (f.b1 - f.b3) * f.b3;\n  f.rho = up * up / (1.0 - f.b1 - f.b2 - f.b3);\n  f.radius = min(int(ceil(6.0 * sigma)), 24);\n  f.u1 = (f.b1 + f.b2 * f.b3) / (1.0 - f.b2 - f.b1 * f.b3 - f.b3 * f.b3);\n  f.u2 = f.b2 + (f.b1 + f.b3) * f.u1;\n  float t0 = 1.0;\n  float t1 = f.u1;\n  float t2 = f.u2;\n  float sum = 1.0 + 2.0 * (t1 + t2);\n  for (int k = 3; k <= 24; k++) {\n    if (k > f.radius) break;\n    float next = f.b1 * t2 + f.b2 * t1 + f.b3 * t0;\n    t0 = t1;\n    t1 = t2;\n    t2 = next;\n    sum += 2.0 * next;\n  }\n  f.norm = sum;\n  return f;\n}\n\n// What the line being blurred holds at a texel: the lightness, and in the\n// second blur the first blur's result on top of it.\nfloat inrLineValue(ivec2 p, ivec2 size, bool second) {\n  vec4 t = fetchPrev4(clamp(p, ivec2(0), size - 1));\n  return inrLightness(t.rgb) + (second ? t.w : 0.0);\n}\n\n// The blur of a line along e (n texels long, this one the j-th) less this\n// texel's own value. The taps read the edge pixel past either end, which is\n// what the plain routines of gauss.cc do. The SSE routines the CLI runs start\n// the backward recursion from a boundary matrix scaled by rho more, so the\n// last texels differ: the difference at the three texels past the edge is\n// worked out from the edge pixel and carried back by the recursion's own\n// (homogeneous) step, as USM and RL Sharpening does. Those three sums take the\n// edge pixel for every offset from the edge on, and the texels before it\n// once each, against the taps i, i + 1 and i + 2 of the window at i.\nfloat inrBlurLine(ivec2 q, ivec2 e, int n, int j, float own, bool second) {\n  InrFilter f = inrFilter();\n  ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));\n  float w0 = 1.0;\n  float w1 = f.u1;\n  float w2 = f.u2;\n  float acc = w0 / f.norm * (inrLineValue(q, size, second) - own);\n  for (int k = 1; k <= 24; k++) {\n    if (k > f.radius) break;\n    float next = f.b1 * w2 + f.b2 * w1 + f.b3 * w0;\n    w0 = w1;\n    w1 = w2;\n    w2 = next;\n    acc += w0 / f.norm * ((inrLineValue(q + e * k, size, second) - own) + (inrLineValue(q - e * k, size, second) - own));\n  }\n  int d = n - 1 - j;\n  if (d <= f.radius) {\n    float edge = inrLineValue(q + e * d, size, second) - own;\n    w0 = 1.0;\n    w1 = f.u1;\n    w2 = f.u2;\n    float head = w0 / f.norm;\n    float y0 = 0.0;\n    float y1 = 0.0;\n    float y2 = 0.0;\n    for (int i = 1; i <= 24; i++) {\n      if (i > f.radius) break;\n      float next = f.b1 * w2 + f.b2 * w1 + f.b3 * w0;\n      w0 = w1;\n      w1 = w2;\n      w2 = next;\n      float v = inrLineValue(q + e * (d - i), size, second) - own;\n      head += w0 / f.norm;\n      y0 += w0 / f.norm * v;\n      y1 += (i + 1 > f.radius ? 0.0 : w1) / f.norm * v;\n      y2 += (i + 2 > f.radius ? 0.0 : w2) / f.norm * v;\n    }\n    float t1 = f.u1 / f.norm;\n    float t2 = f.u2 / f.norm;\n    float c0 = (f.rho - 1.0) * (y0 + edge * head - edge);\n    float c1 = (f.rho - 1.0) * (y1 + edge * (head + t1) - edge);\n    float c2 = (f.rho - 1.0) * (y2 + edge * (head + t1 + t2) - edge);\n    for (int t = 0; t < 24; t++) {\n      if (t >= d) break;\n      float next = f.b1 * c0 + f.b2 * c1 + f.b3 * c2;\n      c2 = c1;\n      c1 = c0;\n      c0 = next;\n    }\n    acc += c0;\n  }\n  return acc;\n}\n", M = "\nc.w = 0.0;\nc = inrHalf4(c);\n", N = "\nivec2 q = ivec2(gl_FragCoord.xy);\nivec2 size = ivec2(floor(1.0 / uTexel + 0.5));\nc.w = inrBlurLine(q, ivec2(1, 0), size.x, q.x, inrLightness(c.rgb), false);\nc = inrHalf4(c);\n", P = "\nivec2 q = ivec2(gl_FragCoord.xy);\nivec2 size = ivec2(floor(1.0 / uTexel + 0.5));\n// The line holds lightness plus the first blur, so the high-pass is taken\n// against the lightness alone: the first blur's w is added back.\nfloat lowH = c.w;\nfloat own = inrLightness(c.rgb) + lowH;\nc.w = abs(inrBlurLine(q, ivec2(0, 1), size.y, q.y, own, true) + lowH);\nc = inrHalf4(c);\n", F = "\nivec2 q = ivec2(gl_FragCoord.xy);\nivec2 size = ivec2(floor(1.0 / uTexel + 0.5));\nfloat gain = max(1.0, 5.5 - inrThresh()) / 24.0;\nfloat total = 0.0;\nfor (int dy = -2; dy <= 2; dy++) {\n  for (int dx = -2; dx <= 2; dx++) {\n    ivec2 p = q + ivec2(dx, dy);\n    if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;\n    total += fetchPrev4(p).w;\n  }\n}\nc.w = c.w > (total - c.w) * gain ? 1.0 : 0.0;\nc = inrHalf4(c);\n", I = `
ivec2 q = ivec2(gl_FragCoord.xy);
ivec2 size = ivec2(floor(1.0 / uTexel + 0.5));
vec4 keep = vec4(c.rgb, 0.0);
if (size.x < 8 || size.y < 8 || c.w < 0.5) {
  c = keep;
} else {
  float centre = inrLightness(c.rgb);
  float norm = 0.0;
  vec3 sum = vec3(0.0);
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 p = q + ivec2(dx, dy);
      if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) continue;
      vec4 n = fetchPrev4(p);
      if (n.w > 0.5) continue;
      vec3 lab = inrToState(n.rgb);
      float d = (lab.x - centre) * ${b(n)};
      float w = 1.0 / (d * d + ${b(1)});
      sum += w * lab;
      norm += w;
    }
  }
  c = norm > 0.0 ? vec4(inrFromState(sum / norm), 0.0) : keep;
}
c = inrHalf4(c);
`, L = "\nif (enabled != 0) {\n  vec3 change = stageResult - inrHalf3(c);\n  if (any(greaterThan(abs(change), abs(c) * 0.002 + 0.000001))) {\n    c += change;\n  }\n}\n", R = {
	key: "enabled",
	glslType: "int",
	default: +!!e.enabled,
	range: {
		min: 0,
		max: 1,
		step: 1
	},
	label: o.enabled
}, z = {
	key: "threshold",
	glslType: "int",
	default: e.threshold,
	range: {
		...t.threshold,
		step: 1
	},
	label: o.threshold
}, B = {
	key: "enabled",
	max: 1
}, V = (e, t, n = []) => ({
	channels: 4,
	glsl: e,
	helpers: t,
	uniforms: n,
	iterations: B
});
function H() {
	return {
		id: i,
		name: a,
		phase: "display-adjust",
		priority: 10,
		reads: "current",
		space: {
			encoding: "linear",
			primaries: "rec709"
		},
		glsl: L,
		helpers: A,
		uniforms: [R, z],
		passes: [
			V(M, A),
			V(N, O + k + j + A, [z]),
			V(P, O + k + j + A, [z]),
			V(F, k + A, [z]),
			V(I, O + A)
		],
		dormantWhen: { enabled: 0 },
		mask: { maskable: !0 }
	};
}
//#endregion
//#region src/index.tsx
var U = `${r}.panel`;
function W() {
	let e = g.stores.useDevelopStore.getState();
	e.setDynParams(m()), e.commitEdit(c);
}
function G(e) {
	_(e), e.registerProcessingStage(H()), e.registerPanel({
		id: U,
		title: a,
		component: v,
		defaultDock: {
			module: "develop",
			direction: "right",
			width: 280
		},
		onReset: W,
		mask: {
			component: v,
			owns: l.map(u)
		}
	});
}
function K() {}
//#endregion
export { U as PANEL_ID, G as activate, K as deactivate };

//# sourceMappingURL=index.js.map