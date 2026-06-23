import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/platforms/shopify.ts",
    "src/platforms/woocommerce.ts",
    "src/platforms/stripe.ts",
    "src/platforms/paypal.ts",
    "src/platforms/amazon.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
});
