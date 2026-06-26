# @warp-lang/commerce-registry

A mechanism for describing and indexing community commerce adapters. It is three
things and no more:

- a manifest **format** — a documented type for describing an adapter: its name,
  the platform it targets, its inbound/outbound capabilities, and its conformance
  status.
- a local **index** — an in-memory collection of registered manifests, with
  list/filter/lookup.
- a **validator** — checks a candidate manifest against the format and reports
  every problem with a locatable, readable message.

It is a format plus tooling, not a hosted registry service. It persists nothing,
fetches nothing over the network, and never loads or runs the adapters it
describes. A manifest is data about an adapter; this package helps you write,
validate, and organize that data.

This package is private and unpublished (`0.1.0`).

## The manifest format

A manifest is the registry's own descriptive type. It is deliberately separate
from the frozen Warp Commerce Model schema (the invariants, the transition graph,
the structural shapes in `schema/`): a manifest describes an *adapter*, not a
commerce object, and editing it never touches the model.

```ts
interface AdapterManifest {
  name: string;          // unique key in an index; lowercase, digits, hyphens
  platform: string;      // the external system targeted (see KNOWN_PLATFORMS)
  capabilities: AdapterCapability[]; // non-empty list of mappings
  conformance: "unverified" | "self-reported" | "verified";
  description?: string;
  version?: string;
  homepage?: string;
}

interface AdapterCapability {
  direction: "inbound" | "outbound"; // platform->Warp, or Warp->platform
  entity: string;                    // the Warp-model concept involved
  via: string;                       // the exported mapping function (documentary)
}
```

`conformance` records how far an adapter has been checked against the canonical
conformance harness; it is a claim about process, not a guarantee about the
adapter's code. `via` names the function that performs a mapping so a reader can
find it in source — the registry never calls it.

## Usage

```ts
import { AdapterRegistry, validateManifest } from "@warp-lang/commerce-registry";

const registry = new AdapterRegistry();

registry.register({
  name: "acme-shop",
  platform: "acme",
  conformance: "self-reported",
  capabilities: [{ direction: "inbound", entity: "Commitment", via: "fromAcmeOrder" }],
});

registry.list();                       // -> [manifest, ...] sorted by name
registry.listByPlatform("acme");       // filter by platform
registry.listByConformance("verified"); // filter by conformance status

// Validate without registering:
const result = validateManifest(candidate);
if (!result.valid) console.error(result.issues);
```

Registration validates first, so an index only ever holds well-formed manifests.
A malformed manifest is rejected with the validator's issues, never silently
stored. Re-registering a name throws; use `replace` to overwrite deliberately.

## Example

`examples/register-existing-adapters.mjs` registers the four adapters that ship
in `@warp-lang/commerce-types` (Shopify, Stripe, PayPal, Amazon) via manifests,
validates them, lists them, and rejects a malformed manifest. It also imports each
platform module and checks that every function a manifest names in `via` is a real
export — confirming the descriptions match the shipped code.

```sh
npm install --include=dev
npm run build
npm run example
```

## Scripts

- `npm run build` — bundle to `dist/` (dual ESM/CJS with types)
- `npm test` — run the validator and index tests
- `npm run typecheck` — `tsc --noEmit`
- `npm run example` — run the registration demo (build first)
