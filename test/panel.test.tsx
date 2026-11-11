import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { activate } from "../src/index";
import { ImpulseNoiseReductionPanel } from "../src/Panel";
import { qualified } from "../src/params";
import { React } from "../src/rt";
import { fakeApi } from "./support/fake-api";

function setup(params: Record<string, unknown> = {}) {
  const rig = fakeApi(params);
  activate(rig.api);
  const view = render(<ImpulseNoiseReductionPanel />);
  const slider = () => {
    const found = rig.sliders(view.container).find((s) => s.label === "Threshold");
    if (!found) throw new Error("no Threshold slider");
    return found;
  };
  const toggle = () => {
    const found = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!found) throw new Error("no switch");
    return found;
  };
  return { rig, view, slider, toggle };
}

afterEach(cleanup);

describe("the panel", () => {
  it("has the tool's switch and its one slider", () => {
    const { rig, view, toggle } = setup();
    expect(rig.sliders(view.container).map((s) => s.label)).toEqual(["Threshold"]);
    expect(toggle().getAttribute("aria-label")).toBe("Enabled");
    expect(toggle().checked).toBe(false);
  });

  it("shows the tool's default and range: 50 of 0 to 100", () => {
    const { slider } = setup();
    expect(slider()).toMatchObject({ value: 50, min: 0, max: 100, step: 1, defaultValue: 50 });
  });

  it("writes the threshold as the slider moves, and one undo step on release", () => {
    const { rig, slider } = setup();
    act(() => slider().onChange(80));
    expect(rig.params()).toEqual({ [qualified("enabled")]: 0, [qualified("threshold")]: 80 });
    expect(slider().value).toBe(80);
    act(() => slider().onCommit?.());
    expect(rig.commits).toEqual(["Impulse Noise Reduction: Threshold"]);
  });

  it("turns on and off, each one undo step, and keeps the threshold", () => {
    const { rig, toggle } = setup({ [qualified("threshold")]: 30 });
    act(() => toggle().click());
    expect(rig.params()).toEqual({ [qualified("enabled")]: 1, [qualified("threshold")]: 30 });
    act(() => toggle().click());
    expect(rig.params()[qualified("enabled")]).toBe(0);
    expect(rig.commits).toEqual(["Impulse Noise Reduction: Enabled", "Impulse Noise Reduction: Enabled"]);
  });
});
