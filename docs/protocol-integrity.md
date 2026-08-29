# Commerce integrity beneath the agentic-commerce protocols

**What this document is.** A map of where Warp sits relative to the agentic-commerce
protocols, the specific gap those protocols leave open by design, and how Warp's
existing guardrail can be called to fill it — over MCP, the substrate they already
speak.

**What this document is not.** It is not a claim of any relationship with these
protocols or their maintainers. No protocol described here has adopted, integrated,
reviewed, or endorsed Warp, and this page does not suggest otherwise. Everything
below describes an integration capability built **on Warp's side**, against public
descriptions of what each protocol does. Warp is complementary to these protocols
and runs beneath them; it is not an alternative to any of them.

> **Landscape snapshot — August 2026.** This space is moving quickly. The layer map
> below reflects each protocol's publicly stated scope at the time of writing.
> Before relying on it, check each protocol's current specification directly —
> and if one of them takes commerce integrity in-scope, this page should be updated
> to say so.

---

## The protocols are layers, not rivals

It is tempting to read UCP, ACP and AP2 as competitors. They are not: they answer
different questions at different points in one purchase, and MCP is the transport
they increasingly share.

| Layer | The question it answers | Where it shows up |
| --- | --- | --- |
| **Discovery + cart** | *What can be bought, and what is in the cart?* | UCP (Google / Shopify) |
| **Checkout** | *Carry out the purchase.* | ACP (OpenAI / Stripe) |
| **Payment authorization** | *Who authorized this, and may they spend it?* | AP2 (Google / FIDO) |
| **Tool / data substrate** | *How does an agent call any of this?* | MCP — ACP added MCP compatibility; UCP serves over MCP |
| **Structural integrity** | *Is this internally coherent commerce?* | **Warp — this layer** |

A single agent-driven purchase can touch all of them: discover and build a cart,
run checkout, authorize the payment. Each hands off to the next.

## The gap all of them leave open

None of these protocols validates that the commerce itself makes sense — and this
is deliberate, not an oversight. They say so.

ACP's documentation places PSP capture semantics, returns and exchanges, tax
configuration, and fraud modeling outside its scope: these "remain with the
merchant's existing systems." The other layers draw their boundaries in the same
place. AP2 answers whether a payment is *authorized*, not whether the amount makes
sense against what was actually committed. UCP describes carts and catalogs, not
the arithmetic of a refund against a capture.

So none of them answers, and none of them claims to answer:

- Is this refund **less than or equal to** what was actually captured?
- Is **value conserved** across this action, in one currency, without silent mixing?
- Is this a **legal state move** — or is a shipped order being quietly walked back
  to "accepted"?
- Do the components of this settlement — principal, tax, fees, shipping —
  **reconcile** to the committed total?
- Do the child commitments of a split order still **sum to the parent**?

That set of questions is one layer, it is well-defined, and today it sits with
"the merchant's existing systems" — which for an agent-driven purchase often means
nothing is checking it at the moment the agent acts.

**That layer is what Warp is.** Not a replacement for the protocols above it —
the check they each say is somebody else's job.

## What Warp checks

Warp's six invariants, applied to a proposed action **before** it commits:

| | Invariant | What it catches |
| --- | --- | --- |
| I-1 | Value conservation | An over-refund; currency mixed without explicit conversion; a settlement whose components do not sum to its total |
| I-2 | State monotonicity | A backward or illegal state move — a fulfilled order returning to accepted, a cancelled one being fulfilled |
| I-3 | Capacity verification | A commitment accepted by a party that has not been verified as able to make it |
| I-4 | Temporal integrity | Backdated history; fulfillment recorded before the commitment it fulfills |
| I-5 | Identity permanence | A reused or reassigned entity id |
| I-6 | Commitment tree consistency | Split-order children that no longer sum to their parent |

These are structural properties of the commerce record. They are independent of
who authorized the action, which PSP captures it, and how checkout executes —
which is exactly why they can be checked underneath all of it.

## How the bridge works

The [`@warp-lang/commerce-mcp`](../packages/commerce-mcp) server exposes Warp's
guardrail as MCP tools. The `guard_protocol_action` tool takes an action shaped
the way one of these protocols carries it and does exactly two things:

1. **Map** — translate the protocol payload into Warp's `ProposedAction`. Pure
   mapping; no invariant logic.
2. **Guard** — hand it to the unmodified, published `guardAction`, and return its
   verdict **verbatim**.

The second step is the point. The bridge adds **no** integrity semantics: whatever
`guard_action` would have said about the mapped action is exactly what comes back.
That equivalence is asserted as a test, not as a promise — see
`test/protocol.test.ts`.

### Three outcomes, and the middle one matters most

| Result | Meaning |
| --- | --- |
| `mapped: true`, `verdict.ok: true` | The commerce move is structurally coherent. |
| `mapped: true`, `verdict.ok: false` | Blocked, with the invariant, the reason, the fix, and the legal alternative moves. |
| `mapped: false`, `verdict: null` | **Warp expressed no opinion.** The action was never checked — neither approved nor rejected. |

The third row is a safety property, not a limitation. When a protocol concept has
no sound Warp counterpart, the adapter refuses to map it rather than inventing a
commitment move to cover the difference. **A caller that treats `verdict: null` as
a pass has defeated the point of asking.**

## The mappings, and where they honestly stop

Each adapter reports the fields it read (`mapped`), the fields it read only in
order to disclaim (`outOfScope`), and refuses outright where there is no sound
mapping. These shapes are defined on Warp's side; they are representative subsets,
not the protocols' normative schemas.

### Checkout-shaped (ACP-style)

| Protocol action | Warp state | |
| --- | --- | --- |
| `checkout_session` → `ready_for_payment` | `Proposed` | |
| `checkout_session` → `completed` | `Accepted` | |
| `checkout_session` → `canceled` | `Cancelled` | |
| `order` → `confirmed` | `Accepted` | |
| `order` → `fulfilled` | `Fulfilled` | |
| `order` → `canceled` | `Cancelled` | |
| `order` → `refunded` | `Refunded` | requires the amount — I-1 needs the number |
| `checkout_session` → `not_ready_for_payment`, `in_progress` | — | **gap:** pre-commitment. Warp models this as an `Intent`; `guard_action` moves commitments |
| `order` → `shipped` | — | **gap:** does not say *which* line items shipped. Warp separates `PartiallyFulfilled` (with item ids) from `Fulfilled`, and will not assert a completeness the payload does not state |

Not interpreted: PSP and capture configuration, tax configuration, shipping
detail, fraud/risk signals.

### Cart-shaped (UCP-style)

| Protocol action | Warp state | |
| --- | --- | --- |
| `cart` → `checkout` | `Proposed` | the handoff: the cart becomes a proposed commitment |
| `order` → `place_order` | `Accepted` | |
| `order` → `cancel` | `Cancelled` | |
| `order` → `add_item` / `update_item` / `remove_item` | `Modified` | Warp checks the move is legal, not that the new line set is what the buyer agreed to |
| `cart` → `add_item` / `update_item` / `remove_item` / `cancel` | — | **gap:** a cart is not a commitment. Nobody has committed to anything yet; mapping it would manufacture an agreement that does not exist |

Not interpreted: catalog and product-feed references, merchant identity.

### Payment-shaped (AP2-style)

| Protocol action | Warp state | |
| --- | --- | --- |
| `authorize` | `Accepted` | Warp checks the move is legal; it does not perform or validate the authorization |
| `refund` | `Refunded` | |
| `capture` | — | **gap:** moving funds is not a commitment state change. Warp models the money leg as a `Fulfillment` |

Not interpreted: the mandate itself — its credential, signature, validity window,
and **its spending cap**.

That last one deserves saying plainly, because it is the easiest thing to assume
wrongly. **A mandate's cap is not a Warp invariant.** The two checks are
independent, and they come apart in both directions:

- An action **within** the mandate cap can still be **blocked** by Warp — a
  500 MAD refund under a 900 MAD mandate, against an order only committed at
  200 MAD, fails I-1.
- An action that **breaches** the mandate cap can still be **cleared** by Warp — a
  200 MAD refund on a 200 MAD order is coherent commerce, whatever the mandate
  says.

Both directions are covered by tests. The authorization layer must enforce its own
cap; Warp will not do it for you.

## What a passing verdict does not mean

`ok: true` means the action is coherent commerce under Warp's six invariants. It
does **not** mean:

- the payment is authorized, or the mandate is valid;
- the buyer consented, or the agent had permission to act;
- checkout may proceed, or the merchant will accept the order;
- the goods exist, the price is right, or the transaction is not fraud.

Warp answers one question. Treating its verdict as clearance for any of the above
would be a misuse of it.

## Scope

Warp validates and returns verdicts. It does not execute payments, run checkout,
settle funds, verify identity, model fraud, hold credentials, or make network
calls. It is complementary to the protocols described here and runs beneath them.

This page describes a capability on Warp's side. It asserts no partnership,
integration, adoption, or endorsement by any protocol or organization named, and
none should be inferred from the mappings above.

## Try it

```bash
cd packages/commerce-mcp
npm ci && npm run build
node examples/protocol-bridge.mjs
```

The run shows a checkout-shaped over-refund blocked with its fix, the agent
correcting it, a cart mutation returning no verdict at all, an illegal state move
blocked with the legal alternatives, and a refund that satisfies its payment
mandate but still fails value conservation.

## See also

- [`packages/commerce-mcp`](../packages/commerce-mcp) — the MCP server and its tools
- [`docs/WARP_COMMERCE_MODEL.md`](WARP_COMMERCE_MODEL.md) — the model and its invariants
- [Model Context Protocol](https://modelcontextprotocol.io) — the substrate the bridge is served over
