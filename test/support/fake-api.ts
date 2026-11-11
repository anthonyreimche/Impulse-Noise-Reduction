// A stand-in Safelight API for unit tests, over real React and zustand. It has
// only what this extension uses: reading any other member throws, naming it,
// so a test shows what to add here when the extension starts using more.
//
// The photo's edit is a param bag in a zustand store, so a panel re-renders
// when it changes. Reads fall back to the defaults of the registered stages'
// uniforms, as Safelight's do. Core's Slider is a stub that keeps the props it
// was last drawn with, so a test can drive a drag and its release; the
// Stack and Toggle are plain DOM. `getParams` reads the bag as it is now, as
// the host's does, which a drag faster than React's renders relies on.

import * as React from "react";
import { create } from "zustand";
import type {
  PanelContribution,
  ParamScope,
  ProcessingStageContribution,
  SafelightAPI,
  SliderProps,
  StackProps,
  ToggleProps,
} from "../../src/safelight";
import { EXT_ID as EXTENSION_ID } from "../../src/params";

/** The members of SafelightAPI this fake implements, typed against the real thing. */
type FakeMembers = Pick<
  SafelightAPI,
  "version" | "extensionId" | "react" | "registerPanel" | "registerProcessingStage" | "unregisterProcessingStage"
> & {
  components: Pick<SafelightAPI["components"], "Slider">;
  develop: Pick<SafelightAPI["develop"], "useParamScope">;
  ui: Pick<SafelightAPI["ui"], "Stack" | "Toggle">;
  stores: Pick<SafelightAPI["stores"], "create" | "useDevelopStore">;
};

/** The develop store's members this extension touches. */
interface FakeDevelop {
  paramBag: Record<string, unknown>;
  params: { masks: { id: string; bag?: Record<string, unknown> }[] };
  setDynParams(patch: Record<string, unknown>): void;
  updateMaskBag(id: string, patch: Record<string, unknown>): void;
  commitEdit(label: string): Promise<void>;
}

export interface Rig {
  api: SafelightAPI;
  panels: PanelContribution[];
  stages: ProcessingStageContribution[];
  /** The photo's param bag, by qualified key, without defaults. */
  params(): Readonly<Record<string, unknown>>;
  /** The labels of the undo steps the extension made, in order. */
  commits: string[];
  /** The latest props of each slider drawn in `root`, in document order. */
  sliders(root: ParentNode): SliderProps[];
  /** The stage ids unregistered, in order. */
  unregistered: string[];
  /** Replaces the photo's bag from outside the panel, as an undo or a paste would. */
  replace(params: Record<string, unknown>): void;
  /** Replaces the photo's masks, as adding one or pasting into one would. */
  setMasks(masks: { id: string; bag?: Record<string, unknown> }[]): void;
  /** A mask's bag. */
  maskBag(id: string): Readonly<Record<string, unknown>> | undefined;
}

export function fakeApi(initial: Record<string, unknown> = {}): Rig {
  const panels: PanelContribution[] = [];
  const stages: ProcessingStageContribution[] = [];
  const commits: string[] = [];
  const defaults = new Map<string, unknown>();
  const develop = create<FakeDevelop>()((set) => ({
    paramBag: { ...initial },
    params: { masks: [] },
    setDynParams: (patch) =>
      set((s) => {
        const next = { ...s.paramBag, ...patch };
        for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
        return { paramBag: next };
      }),
    updateMaskBag: (id, patch) =>
      set((s) => ({
        params: { masks: s.params.masks.map((m) => (m.id === id ? { ...m, bag: { ...m.bag, ...patch } } : m)) },
      })),
    commitEdit: async (label) => void commits.push(label),
  }));
  const sliderProps = new Map<number, SliderProps>();
  const unregistered: string[] = [];
  let nextSlider = 0;

  function useParamScope(): ParamScope {
    const params = develop((s) => s.paramBag);
    return {
      maskId: null,
      getParam: (key) => (key in params ? params[key] : defaults.get(key)),
      getParams: () => develop.getState().paramBag,
      setParams: (patch) => develop.getState().setDynParams(patch),
      commit: (label) => void commits.push(label),
    };
  }

  function Slider(props: SliderProps) {
    const id = React.useRef(nextSlider++).current;
    sliderProps.set(id, props);
    return React.createElement("div", { "data-slider": id }, `${props.label} ${props.value}`);
  }

  const members: FakeMembers = {
    version: 1,
    extensionId: EXTENSION_ID,
    react: React,
    registerPanel: (c) => void panels.push(c),
    registerProcessingStage: (c) => {
      stages.push(c);
      for (const u of c.uniforms) defaults.set(`${c.id}.${u.key}`, u.default);
    },
    unregisterProcessingStage: (id) => void unregistered.push(id),
    components: { Slider },
    develop: { useParamScope },
    ui: ui as unknown as FakeMembers["ui"],
    stores: { create, useDevelopStore: develop as unknown as SafelightAPI["stores"]["useDevelopStore"] },
  };

  return {
    api: strict(members, "api") as unknown as SafelightAPI,
    panels,
    stages,
    params: () => develop.getState().paramBag,
    commits,
    unregistered,
    replace: (params) => develop.setState({ paramBag: { ...params } }),
    setMasks: (masks) => develop.setState({ params: { masks } }),
    maskBag: (id) => develop.getState().params.masks.find((m) => m.id === id)?.bag,
    sliders: (root) =>
      [...root.querySelectorAll("[data-slider]")].map((el) => {
        const props = sliderProps.get(Number(el.getAttribute("data-slider")));
        if (!props) throw new Error("a slider without props");
        return props;
      }),
  };
}

const e = React.createElement;

const ui = {
  Stack: (props: StackProps) => e("div", null, props.children),
  Toggle: (props: ToggleProps) =>
    e(
      "label",
      null,
      props.label,
      e("input", {
        type: "checkbox",
        "aria-label": props.ariaLabel ?? (typeof props.label === "string" ? props.label : undefined),
        checked: props.checked,
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) => props.onChange(ev.target.checked),
      }),
    ),
};

/** Wraps a plain object so reading a member it lacks throws, naming the member. */
function strict<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === "symbol" || key === "then" || key === "toJSON") return Reflect.get(obj, key, receiver);
      if (!(key in obj)) throw new Error(`The fake API has no ${path}.${key}. Add it to test/support/fake-api.ts.`);
      const value: unknown = Reflect.get(obj, key, receiver);
      const isPlainObject = typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
      return isPlainObject && key !== "react" ? strict(value, `${path}.${key}`) : value;
    },
  });
}
