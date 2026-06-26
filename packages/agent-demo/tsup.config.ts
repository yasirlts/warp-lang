import { defineConfig } from "tsup";

// The demo is a runnable CLI. ESM, Node target, shebang so it can be launched
// directly.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
