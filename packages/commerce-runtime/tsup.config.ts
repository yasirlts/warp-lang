import { defineConfig } from "tsup";

// A library (not a binary): callers import the runtime, the stores, and the
// replay helper. Emit both module systems and type declarations, like
// commerce-types and commerce-metrics.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
});
