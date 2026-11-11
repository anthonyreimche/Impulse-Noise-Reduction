// Runtime bindings. JSX in every module compiles (classic transform) to
// React.createElement, resolved against the `React` exported here: the
// instance Safelight passes to activate(). The bundle never imports React
// itself: Safelight loads it without an import map, and a second React would
// break hooks.

import type { SafelightAPI } from "./safelight";

export let React!: SafelightAPI["react"];
export let api!: SafelightAPI;

export function initRuntime(host: SafelightAPI): void {
  api = host;
  React = host.react;
}
