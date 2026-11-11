// The processing stage: five single-draw passes of four channels (glsl.ts) and
// an inline that adds the change the replaced pixels make. RawTherapee runs the
// tool on Lab after the tone curve, so the stage sits in the display phase, in
// linear Rec. 709 with its range left alone. Priority 10 puts it ahead of every
// other display-phase tool (edges 120, microcontrast 130, sharpening 140):
// denoising before the colour edits can amplify the noise.
//
// Both edit keys are declared on the stage as well as on the passes that read
// them: the host builds presets and paste from the stage's own uniforms only.

import {
  BLUR_H_GLSL,
  BLUR_HELPERS,
  BLUR_V_GLSL,
  FLAG_GLSL,
  COLOUR_HELPERS,
  HALF_GLSL,
  INLINE_GLSL,
  REPLACE_GLSL,
  START_GLSL,
  THRESHOLD_HELPERS,
} from "./glsl";
import { DEFAULT_PARAMS, RANGES } from "./model";
import { LABELS, STAGE_ID, TITLE } from "./params";
import type { ProcessingStageContribution, StagePass, UniformDeclaration } from "./safelight";

const ENABLED: UniformDeclaration = {
  key: "enabled",
  glslType: "int",
  default: DEFAULT_PARAMS.enabled ? 1 : 0,
  range: { min: 0, max: 1, step: 1 },
  label: LABELS.enabled,
};

const THRESHOLD: UniformDeclaration = {
  key: "threshold",
  glslType: "int",
  default: DEFAULT_PARAMS.threshold,
  range: { ...RANGES.threshold, step: 1 },
  label: LABELS.threshold,
};

/** One draw while the switch is on, none while it is off. */
const ONCE = { key: "enabled", max: 1 } as const;

const pass = (glsl: string, helpers: string, uniforms: UniformDeclaration[] = []): StagePass => ({
  channels: 4,
  glsl,
  helpers,
  uniforms,
  iterations: ONCE,
});

export function impulseStage(): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: TITLE,
    phase: "display-adjust",
    priority: 10,
    reads: "current",
    space: { encoding: "linear", primaries: "rec709" },
    glsl: INLINE_GLSL,
    helpers: HALF_GLSL,
    uniforms: [ENABLED, THRESHOLD],
    passes: [
      pass(START_GLSL, HALF_GLSL),
      pass(BLUR_H_GLSL, COLOUR_HELPERS + THRESHOLD_HELPERS + BLUR_HELPERS + HALF_GLSL, [THRESHOLD]),
      pass(BLUR_V_GLSL, COLOUR_HELPERS + THRESHOLD_HELPERS + BLUR_HELPERS + HALF_GLSL, [THRESHOLD]),
      pass(FLAG_GLSL, THRESHOLD_HELPERS + HALF_GLSL, [THRESHOLD]),
      pass(REPLACE_GLSL, COLOUR_HELPERS + HALF_GLSL),
    ],
    dormantWhen: { enabled: 0 },
    mask: { maskable: true },
  };
}
