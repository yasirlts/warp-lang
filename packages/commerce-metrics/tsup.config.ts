import { defineConfig } from "tsup";

// A library (not a binary): it exports a wrapper + collector for callers to
// import. Emit both module systems and type declarations, like commerce-types.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
});
