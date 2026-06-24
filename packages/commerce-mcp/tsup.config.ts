import { defineConfig } from "tsup";

// The server is a runnable stdio binary (see `bin` in package.json). It is ESM,
// targets Node, and gets a shebang so it can be launched directly by an MCP host.
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
