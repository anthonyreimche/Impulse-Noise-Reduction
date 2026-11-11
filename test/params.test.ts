import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../src/model";
import { EDIT_KEYS, bagPatch, qualified, readParams, resetPatch } from "../src/params";

describe("the bag", () => {
  it("reads RawTherapee's defaults from an empty bag: off, threshold 50", () => {
    expect(readParams({})).toEqual(DEFAULT_PARAMS);
  });

  it("reads the switch as 0 or 1 and the threshold as a whole number within 0 to 100", () => {
    expect(readParams({ [qualified("enabled")]: 1 }).enabled).toBe(true);
    expect(readParams({ [qualified("enabled")]: 0 }).enabled).toBe(false);
    expect(readParams({ [qualified("threshold")]: 140 }).threshold).toBe(100);
    expect(readParams({ [qualified("threshold")]: -5 }).threshold).toBe(0);
    expect(readParams({ [qualified("threshold")]: 33.6 }).threshold).toBe(34);
  });

  it("skips what isn't a number", () => {
    const p = readParams({ [qualified("threshold")]: "20", [qualified("enabled")]: Number.NaN });
    expect(p).toEqual(DEFAULT_PARAMS);
  });

  it("writes both keys, the switch as 0 or 1", () => {
    expect(bagPatch({ enabled: true, threshold: 70 })).toEqual({ [qualified("enabled")]: 1, [qualified("threshold")]: 70 });
    expect(Object.keys(bagPatch(DEFAULT_PARAMS))).toEqual(EDIT_KEYS.map(qualified));
  });

  it("resets to off at the default threshold", () => {
    expect(resetPatch()).toEqual({ [qualified("enabled")]: 0, [qualified("threshold")]: 50 });
  });
});
