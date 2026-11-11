import { defineConfig } from "vitest/config";

// Classic JSX bound to the `React` each module imports from ./rt: the host's
// React instance, never a bundled one (a second React breaks hooks, and an
// import of "react" left in the bundle fails to load).
const JSX = { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" } as const;

export default defineConfig({
  oxc: { jsx: JSX },
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: "index" },
    rollupOptions: { external: ["react", "react-dom"] },
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    // The GPU spec runs inside a SafeLight checkout (npm run test:gpu).
    exclude: ["test/gpu/**", "node_modules/**"],
    environment: "jsdom",
  },
});
