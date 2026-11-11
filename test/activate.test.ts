import { describe, expect, it } from "vitest";
import { PANEL_ID, activate, deactivate } from "../src/index";
import { EDIT_KEYS, STAGE_ID, qualified } from "../src/params";
import { fakeApi } from "./support/fake-api";

describe("activate", () => {
  it("registers the stage and a panel that also edits masks", () => {
    const rig = fakeApi();
    activate(rig.api);
    expect(rig.stages.map((s) => s.id)).toEqual([STAGE_ID]);
    expect(rig.panels.map((p) => p.id)).toEqual([PANEL_ID]);
    expect(rig.panels[0].mask?.owns).toEqual(EDIT_KEYS.map(qualified));
    deactivate();
  });

  it("resets the photo to off at the default threshold, as one undo step", () => {
    const rig = fakeApi({ [qualified("enabled")]: 1, [qualified("threshold")]: 90 });
    activate(rig.api);
    rig.panels[0].onReset?.();
    expect(rig.params()).toEqual({ [qualified("enabled")]: 0, [qualified("threshold")]: 50 });
    expect(rig.commits).toEqual(["Impulse Noise Reduction reset"]);
    deactivate();
  });
});
