import { defineConfig } from "tsup";

// This package is a library (a manifest format + index + validator), not a
// runnable binary. Emit dual ESM/CJS with type declarations so it can be
// consumed from either module system, mirroring @warp-lang/commerce-types.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: true,
});
