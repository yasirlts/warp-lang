/**
 * Demo: register the adapters that ship in @warp-lang/commerce-types
 * (Shopify, Stripe, PayPal, Amazon) into a local index via manifests, validate
 * each one, then list what the index holds.
 *
 *   npm run build && npm run example
 *
 * To show the manifests describe REAL code, the example also imports each
 * platform module and checks that every function a manifest names in `via`
 * actually exists as an export. The registry never calls those functions — this
 * check just confirms the descriptions are not fiction.
 *
 * This is the mechanism, run end to end. It is a local in-memory index, not a
 * hosted registry: nothing is persisted and nothing is fetched.
 */
import { AdapterRegistry, KNOWN_ADAPTER_MANIFESTS, validateManifest } from "../dist/index.js";

import * as shopify from "@warp-lang/commerce-types/platforms/shopify";
import * as stripe from "@warp-lang/commerce-types/platforms/stripe";
import * as paypal from "@warp-lang/commerce-types/platforms/paypal";
import * as amazon from "@warp-lang/commerce-types/platforms/amazon";

const MODULES = { shopify, stripe, paypal, amazon };

const registry = new AdapterRegistry();

console.log("Registering the shipped commerce-types adapters via manifests:\n");

for (const manifest of KNOWN_ADAPTER_MANIFESTS) {
  const result = validateManifest(manifest);
  if (!result.valid) {
    console.error(`  ${manifest.name}: INVALID`);
    process.exit(1);
  }
  registry.register(manifest);

  // Confirm every `via` the manifest names is a real export of its platform module.
  const mod = MODULES[manifest.platform];
  const missing = manifest.capabilities.map((c) => c.via).filter((fn) => typeof mod?.[fn] !== "function");
  if (missing.length > 0) {
    console.error(`  ${manifest.name}: manifest names functions that do not exist: ${missing.join(", ")}`);
    process.exit(1);
  }

  const inbound = manifest.capabilities.filter((c) => c.direction === "inbound").length;
  const outbound = manifest.capabilities.filter((c) => c.direction === "outbound").length;
  console.log(
    `  registered ${manifest.name.padEnd(8)} platform=${manifest.platform.padEnd(10)} ` +
      `in=${inbound} out=${outbound} conformance=${manifest.conformance}`,
  );
}

console.log(`\nIndex lists ${registry.size} adapters:`);
for (const m of registry.list()) {
  const dirs = [...new Set(m.capabilities.map((c) => c.direction))].sort().join("+");
  console.log(`  - ${m.name.padEnd(8)} (${m.platform}) ${dirs}`);
}

console.log("\nFilter — adapters with an outbound mapping:");
for (const m of registry.list().filter((x) => x.capabilities.some((c) => c.direction === "outbound"))) {
  console.log(`  - ${m.name}`);
}

// Demonstrate the validator rejecting a malformed manifest with a clear error.
console.log("\nValidator rejects a malformed manifest:");
const bad = validateManifest({ name: "Bad Name!", platform: "x", conformance: "trusted", capabilities: [] });
if (bad.valid) {
  console.error("  expected the malformed manifest to be rejected");
  process.exit(1);
}
for (const issue of bad.issues) {
  console.log(`  ${issue.path || "(root)"}: ${issue.message}`);
}

console.log("\nOK — 4 adapters registered and listed; malformed manifest rejected.");
