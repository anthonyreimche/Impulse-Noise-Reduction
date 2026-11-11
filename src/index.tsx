// Impulse Noise Reduction, a Safelight extension (GPL-3.0-or-later).
//
// A port of RawTherapee 5.13's Impulse Noise Reduction: isolated bright and
// dark pixels are found against a Gaussian low-pass of the lightness and
// replaced from their neighbours. From RawTherapee's
//   rtengine/impulse_denoise.cc     © 2010 Emil Martinec <ejmartin@uchicago.edu>
//   rtengine/gauss.cc, color.cc, color.h, iccmatrices.h
//                                   © 2004-2010 Gabor Horvath <hgabor@rawtherapee.com>
// and its procparams.cc and rtgui/tools/impulsedenoise.cc for the setting.
// Registers the display-phase stage (stage.ts) and the Develop panel
// (Panel.tsx), which also edits a mask's in the Masking panel.

import { ImpulseNoiseReductionPanel } from "./Panel";
import { EDIT_KEYS, EXT_ID, RESET_LABEL, TITLE, qualified, resetPatch } from "./params";
import { api, initRuntime } from "./rt";
import type { SafelightAPI } from "./safelight";
import { impulseStage } from "./stage";

export const PANEL_ID = `${EXT_ID}.panel`;

function reset(): void {
  const dev = api.stores.useDevelopStore.getState();
  dev.setDynParams(resetPatch());
  void dev.commitEdit(RESET_LABEL);
}

export function activate(host: SafelightAPI): void {
  initRuntime(host);
  host.registerProcessingStage(impulseStage());
  host.registerPanel({
    id: PANEL_ID,
    title: TITLE,
    component: ImpulseNoiseReductionPanel,
    defaultDock: { module: "develop", direction: "right", width: 280 },
    onReset: reset,
    mask: { component: ImpulseNoiseReductionPanel, owns: EDIT_KEYS.map(qualified) },
  });
}

/** The host sweeps the stage and the panel after every deactivate. */
export function deactivate(): void {}
