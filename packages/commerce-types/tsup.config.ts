import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/platforms/shopify.ts",
    "src/platforms/woocommerce.ts",
    "src/platforms/stripe.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
});
