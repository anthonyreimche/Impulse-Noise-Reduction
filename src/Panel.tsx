// The panel: RawTherapee's tool, a switch and one slider. A drag writes the
// value live and commits on release, so one gesture is one undo step; each
// change reads the bag the scope holds now, as drags outrun renders.
//
// It edits whatever useParamScope hands it: the photo's bag in the dock, a
// mask's in the Masking panel.

import { DEFAULT_PARAMS, RANGES } from "./model";
import { LABELS, bagPatch, historyLabel, readParams } from "./params";
import { React, api } from "./rt";

export function ImpulseNoiseReductionPanel() {
  const { Slider } = api.components;
  const { Stack, Toggle } = api.ui;
  const scope = api.develop.useParamScope();
  const params = readParams(scope.getParams());
  const apply = (patch: Partial<typeof params>) => scope.setParams(bagPatch({ ...readParams(scope.getParams()), ...patch }));

  return (
    <Stack gap={6} style={{ padding: 8 }}>
      <Toggle
        label={LABELS.enabled}
        checked={params.enabled}
        onChange={(enabled) => {
          apply({ enabled });
          scope.commit(historyLabel("enabled"));
        }}
      />
      <Slider
        label={LABELS.threshold}
        value={params.threshold}
        min={RANGES.threshold.min}
        max={RANGES.threshold.max}
        step={1}
        defaultValue={DEFAULT_PARAMS.threshold}
        onChange={(threshold) => apply({ threshold })}
        onCommit={() => scope.commit(historyLabel("threshold"))}
      />
    </Stack>
  );
}
