import { defineConfig } from "tsup";

// A library: it exports a parser + compiler for callers to import. Emit both
// module systems and type declarations, exactly like commerce-types. The
// commerce-types dependency is external (a normal runtime dep), not bundled.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@warp-lang/commerce-types"],
});
