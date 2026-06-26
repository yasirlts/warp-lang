import { defineConfig } from "tsup";

// cli.ts is the runnable bin (see `bin` in package.json) and gets a shebang.
// index.ts is the importable library surface. Both are ESM targeting Node.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
