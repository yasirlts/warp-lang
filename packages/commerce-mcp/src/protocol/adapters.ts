/**
 * Protocol-shaped action → Warp `ProposedAction`.
 *
 * These adapters are PURE MAPPING. They translate the action an agentic-commerce
 * protocol is about to commit into the action shape Warp's guardrail already
 * takes, and they return it. They do not check invariants, do not consult the
 * transition table, and do not decide anything about safety — that is
 * `guardAction`'s job, unchanged, downstream. Nothing here re-implements a single
 * line of the model.
 *
 * WHY MAPPING IS ITS OWN STEP. Every one of these protocols answers a different
 * question than Warp does — who authorized this, how the cart was discovered, how
 * the money moves. So most of a protocol payload is deliberately NOT Warp's
 * business, and some of it has no sound Warp counterpart at all. Rather than
 * inventing a commitment move to cover the difference, each adapter reports:
 *
 *   - `mapped`     — the fields it DID read, and what each became.
 *   - `outOfScope` — the fields it read only to say it did not interpret them,
 *                    and which layer owns them instead.
 *   - a GAP        — when the action has no sound Warp counterpart, the adapter
 *                    refuses to map rather than guessing.
 *
 * A GAP IS NOT A VERDICT. When an adapter returns `ok: false`, Warp has expressed
 * NO opinion on the action: it is not approved and it is not rejected — it was
 * never checked. Callers must not read an unmappable action as a pass. The bridge
 * tool surfaces this distinction explicitly in its result.
 *
 * SCOPE. The mapping is on Warp's side only. It reflects how Warp models these
 * flows; it is not generated from, validated against, or blessed by any
 * protocol's specification, and it implies no adoption, integration, or
 * endorsement by any protocol or its maintainers.
 */
import {
  currencyDecimals,
  partyId,
  type CommitmentState,
  type Money,
  type ProposedAction,
} from "@warp-lang/commerce-types";
import type { AcpAction, Ap2Action, ProtocolAction, ProtocolId, UcpAction } from "./shapes.js";

/** One field the adapter read, and what it did (or deliberately did not do) with it. */
export interface MappingNote {
  /** The protocol field, as the payload spells it. */
  field: string;
  /** What became of it — the Warp counterpart, or the layer that owns it instead. */
  note: string;
}

/** A successful mapping: the Warp action, plus what was and was not interpreted. */
export interface MappingSuccess {
  ok: true;
  protocol: ProtocolId;
  /** The Warp action, ready for the unmodified `guardAction`. */
  action: ProposedAction;
  /** The fields the adapter read and translated. */
  mapped: MappingNote[];
  /** The fields the adapter deliberately did not interpret, and who owns them. */
  outOfScope: MappingNote[];
}

/**
 * A refusal to map. Warp has NOT evaluated the action — this is a gap in the
 * mapping, not an integrity verdict. `reason` says what could not be mapped;
 * `owner` names the layer the concept belongs to, when there is one.
 */
export interface MappingGap {
  ok: false;
  protocol: ProtocolId;
  /** What has no sound Warp counterpart, in the protocol's own terms. */
  reason: string;
  /** Which layer owns the concept instead, or how to express it so Warp can check it. */
  owner: string;
  /** Still reported, so the caller can see what would have been ignored. */
  outOfScope: MappingNote[];
}

export type MappingResult = MappingSuccess | MappingGap;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Minor units (what these protocols and their PSPs carry) → Warp `Money`. Uses
 * the published `currencyDecimals`, so JPY (0 decimals) and TND (3) are handled
 * by the package's own table rather than an assumed 100. `currencyDecimals` is
 * total — an unrecognized code falls back to 2 decimals.
 */
export function moneyFromMinor(amountMinor: number, currency: string): Money {
  const decimals = currencyDecimals(currency as Money["currency"]);
  return { amount: amountMinor / 10 ** decimals, currency } as Money;
}

/** The note every adapter emits for an amount it converted. */
function amountNote(field: string, minor: number, money: Money): MappingNote {
  return {
    field,
    note:
      `${minor} minor units of ${money.currency} -> Warp Money { amount: ${money.amount}, ` +
      `currency: "${money.currency}" } (via the published currencyDecimals table).`,
  };
}

/** Collect the present optional fields Warp reads only in order to disclaim them. */
function disclaim(
  present: Array<[unknown, MappingNote]>,
): MappingNote[] {
  return present.filter(([value]) => value !== undefined).map(([, note]) => note);
}

// ---------------------------------------------------------------------------
// ACP-shaped — checkout and post-purchase order status
// ---------------------------------------------------------------------------

/** ACP statuses the adapter maps, per object, and the Warp state each becomes. */
const ACP_CHECKOUT_STATUSES = ["ready_for_payment", "completed", "canceled"] as const;
const ACP_ORDER_STATUSES = ["confirmed", "fulfilled", "canceled", "refunded"] as const;

/**
 * A checkout-layer action → a Warp commitment move.
 *
 * Deliberate gaps:
 *   - `not_ready_for_payment` / `in_progress` — a checkout session that has not
 *     reached payment readiness is PRE-commitment. Warp models that as an
 *     `Intent`, and `guard_action` moves commitments, so there is no sound
 *     commitment action to check yet.
 *   - `shipped` — Warp distinguishes a partial fulfillment (which line items
 *     shipped, which remain) from a complete one. A bare `shipped` does not carry
 *     that split, and inventing one would assert a completeness the payload does
 *     not state.
 */
export function fromAcpAction(a: AcpAction): MappingResult {
  const outOfScope: MappingNote[] = [
    {
      field: "(layer)",
      note:
        "Checkout execution — creating the session, collecting payment, and completing " +
        "the purchase — is the checkout protocol's own concern. Warp checks only that the " +
        "resulting commerce move is coherent.",
    },
    ...disclaim([
      [a.payment_provider, { field: "payment_provider", note: "PSP selection and capture semantics stay with the merchant's payment systems; Warp does not authorize, capture, or settle." }],
      [a.tax, { field: "tax", note: "Tax configuration stays with the merchant's tax systems. Warp reconciles supplied component amounts (validate_settlement); it does not compute rates or amounts." }],
      [a.fulfillment, { field: "fulfillment", note: "Shipping and fulfillment detail is carried by the checkout/logistics layer; Warp reads only the state it implies." }],
      [a.risk, { field: "risk", note: "Fraud and risk modeling stays with the merchant's existing systems; Warp does not model fraud." }],
    ]),
  ];

  const gap = (reason: string, owner: string): MappingGap => ({ ok: false, protocol: "acp", reason, owner, outOfScope });

  const mapped: MappingNote[] = [
    { field: "id", note: `Read as the id of the commitment in \`world\` this action moves (correspondence is the caller's assertion; the bridge does not infer it).` },
    { field: "actor", note: "Carried through as the Warp action's actor." },
  ];

  let to: CommitmentState;

  if (a.object === "checkout_session") {
    switch (a.status) {
      case "ready_for_payment":
        to = { type: "Proposed" };
        break;
      case "completed":
        to = { type: "Accepted" };
        break;
      case "canceled":
        to = { type: "Cancelled", by: partyId(a.actor), reason: a.reason ?? "Checkout session canceled.", at: a.at };
        break;
      case "not_ready_for_payment":
      case "in_progress":
        return gap(
          `A checkout session at '${a.status}' has not become a commitment yet.`,
          "Warp models a pre-purchase cart/session as an Intent, not a Commitment. `guard_action` moves commitments, so there is nothing to check until the session reaches payment readiness.",
        );
      default:
        return gap(
          `Unrecognized checkout_session status '${a.status}'.`,
          `The adapter maps ${ACP_CHECKOUT_STATUSES.map((s) => `'${s}'`).join(", ")}. Map this status onto one of those, or express the move as a Warp CommitmentState directly and use guard_action.`,
        );
    }
    mapped.push({ field: "status", note: `ACP checkout_session status '${a.status}' -> Warp CommitmentState '${to.type}'.` });
  } else {
    switch (a.status) {
      case "confirmed":
        to = { type: "Accepted" };
        break;
      case "fulfilled":
        to = { type: "Fulfilled" };
        break;
      case "canceled":
        to = { type: "Cancelled", by: partyId(a.actor), reason: a.reason ?? "Order canceled.", at: a.at };
        break;
      case "refunded": {
        if (a.amount_minor === undefined) {
          return gap(
            "A 'refunded' order carries no amount_minor.",
            "Warp's Refunded state carries the refunded Money, and the over-refund check (I-1) needs it. Supply amount_minor.",
          );
        }
        const amount = moneyFromMinor(a.amount_minor, a.currency);
        to = { type: "Refunded", amount, at: a.at };
        mapped.push(amountNote("amount_minor", a.amount_minor, amount));
        break;
      }
      case "shipped":
        return gap(
          "An order status of 'shipped' does not say which line items shipped and which remain.",
          "Warp separates PartiallyFulfilled (with fulfilled/remaining item ids) from Fulfilled. Send 'fulfilled' when the whole order is complete, or express the partial split as a Warp PartiallyFulfilled state and use guard_action.",
        );
      default:
        return gap(
          `Unrecognized order status '${a.status}'.`,
          `The adapter maps ${ACP_ORDER_STATUSES.map((s) => `'${s}'`).join(", ")}. Map this status onto one of those, or express the move as a Warp CommitmentState directly and use guard_action.`,
        );
    }
    mapped.push({ field: "status", note: `ACP order status '${a.status}' -> Warp CommitmentState '${to.type}'.` });
  }

  return {
    ok: true,
    protocol: "acp",
    action: { commitment: a.id, to, actor: a.actor, ...(a.reason !== undefined ? { reason: a.reason } : {}) },
    mapped,
    outOfScope,
  };
}

// ---------------------------------------------------------------------------
// UCP-shaped — discovery and cart, then the handoff to an order
// ---------------------------------------------------------------------------

/**
 * A discovery/cart-layer action → a Warp commitment move.
 *
 * The central, deliberate gap: a CART IS NOT A COMMITMENT. Adding, updating or
 * removing an item in a cart — and abandoning one — happens before any party has
 * committed to anything. Warp models that as an `Intent`, and `guard_action`
 * operates on commitments. Mapping a cart mutation to a commitment move would
 * manufacture an agreement nobody made, so the adapter refuses.
 *
 * What IS mappable is the handoff and everything after it: a cart reaching
 * checkout becomes a proposed commitment, a placed order an accepted one, and
 * post-order line changes a modification.
 */
export function fromUcpAction(a: UcpAction): MappingResult {
  const outOfScope: MappingNote[] = [
    {
      field: "(layer)",
      note:
        "Product discovery, catalog/feed semantics and cart construction are the discovery " +
        "protocol's own concern. Warp checks only the commitment moves that follow.",
    },
    ...disclaim([
      [a.merchant_id, { field: "merchant_id", note: "Merchant identity and onboarding are the discovery/checkout layer's concern; Warp reads parties from `world`, not from this field." }],
      [a.catalog_ref, { field: "catalog_ref", note: "Catalog and product-feed references belong to the discovery layer; Warp does not resolve them." }],
    ]),
  ];

  const gap = (reason: string, owner: string): MappingGap => ({ ok: false, protocol: "ucp", reason, owner, outOfScope });

  const mapped: MappingNote[] = [
    { field: "id", note: "Read as the id of the commitment in `world` this action moves (correspondence is the caller's assertion; the bridge does not infer it)." },
    { field: "actor", note: "Carried through as the Warp action's actor." },
  ];

  const itemOps = ["add_item", "update_item", "remove_item"];

  if (a.object === "cart") {
    if (itemOps.includes(a.operation) || a.operation === "cancel") {
      return gap(
        `A cart '${a.operation}' happens before any commitment exists.`,
        "Warp models a pre-purchase cart as an Intent, not a Commitment, and guard_action moves commitments. There is no commitment to check until the cart reaches checkout — send operation 'checkout' at that point.",
      );
    }
    if (a.operation !== "checkout") {
      return gap(
        `Operation '${a.operation}' is not defined for a cart.`,
        "A cart maps to Warp only at 'checkout', where it becomes a proposed commitment.",
      );
    }
    mapped.push({ field: "operation", note: "UCP cart 'checkout' -> Warp CommitmentState 'Proposed' (the cart becomes a proposed commitment)." });
    if (a.total_minor !== undefined) {
      mapped.push({
        field: "total_minor",
        note: "Read for reporting only: the committed amount Warp checks against comes from the commitment in `world`, not from this field.",
      });
    }
    return {
      ok: true,
      protocol: "ucp",
      action: { commitment: a.id, to: { type: "Proposed" }, actor: a.actor, ...(a.reason !== undefined ? { reason: a.reason } : {}) },
      mapped,
      outOfScope,
    };
  }

  // object === "order"
  let to: CommitmentState;
  switch (a.operation) {
    case "place_order":
      to = { type: "Accepted" };
      break;
    case "cancel":
      to = { type: "Cancelled", by: partyId(a.actor), reason: a.reason ?? "Order cancelled.", at: a.at };
      break;
    case "add_item":
    case "update_item":
    case "remove_item":
      to = { type: "Modified", modified_by: partyId(a.actor), reason: a.reason ?? `Order line changed (${a.operation}).` };
      break;
    case "checkout":
      return gap(
        "An order has already passed checkout.",
        "Send 'checkout' on the cart, before the order exists.",
      );
    default:
      return gap(`Unrecognized order operation '${a.operation}'.`, "Express the move as a Warp CommitmentState directly and use guard_action.");
  }
  mapped.push({ field: "operation", note: `UCP order '${a.operation}' -> Warp CommitmentState '${to.type}'.` });
  if (to.type === "Modified") {
    mapped.push({
      field: "(line items)",
      note:
        "Warp checks that MODIFYING is a legal move here; it does not verify the new line set is the one the buyer agreed to — that is the checkout layer's concern.",
    });
  }

  return {
    ok: true,
    protocol: "ucp",
    action: { commitment: a.id, to, actor: a.actor, ...(a.reason !== undefined ? { reason: a.reason } : {}) },
    mapped,
    outOfScope,
  };
}

// ---------------------------------------------------------------------------
// AP2-shaped — a spending action taken under a payment mandate
// ---------------------------------------------------------------------------

/**
 * A payment-authorization-layer action → a Warp commitment move.
 *
 * The hard line this adapter holds: WARP DOES NOT EVALUATE THE MANDATE. Whether
 * the credential is validly signed, whether the user granted it, whether it is
 * still in its window, and whether the amount is within its cap are all
 * AUTHORIZATION questions owned by the payment-authorization protocol. Warp maps
 * only the commerce move the mandate would set in motion, and checks that move
 * for structural coherence. A Warp `ok` says the commerce is coherent; it says
 * nothing whatever about whether the payment is authorized.
 *
 * Deliberate gap: `capture`. Capturing funds is payment execution. Warp models
 * the money leg as a `Fulfillment`, while `guard_action` moves commitment state —
 * so a capture is not a commitment transition and has no action to check here.
 */
export function fromAp2Action(a: Ap2Action): MappingResult {
  const outOfScope: MappingNote[] = [
    {
      field: "(layer)",
      note:
        "Payment authorization — who granted the mandate, whether its credential verifies, " +
        "and whether it is still valid — is the authorization protocol's own concern. Warp " +
        "does not verify mandates, identity, or consent.",
    },
    {
      field: "mandate_id",
      note: `Carried through for traceability only ('${a.mandate_id}', type '${a.mandate_type}'). Warp does not resolve or validate the mandate.`,
    },
    ...disclaim([
      [a.credential, { field: "credential", note: "The signed credential proving the mandate is verified by the authorization layer. Warp does not check signatures." }],
      [
        a.max_amount_minor,
        {
          field: "max_amount_minor",
          note:
            `NOT ENFORCED by Warp. A mandate's spending cap is an authorization constraint, not one of Warp's six invariants — ` +
            `Warp checks the amount against the COMMITTED amount in \`world\` (I-1), which is a different question. ` +
            `The authorization layer must enforce the cap itself.`,
        },
      ],
    ]),
  ];

  const gap = (reason: string, owner: string): MappingGap => ({ ok: false, protocol: "ap2", reason, owner, outOfScope });

  const mapped: MappingNote[] = [
    { field: "commitment_ref", note: "Read as the id of the commitment in `world` this action moves (correspondence is the caller's assertion; the bridge does not infer it)." },
    { field: "actor", note: "Carried through as the Warp action's actor." },
  ];

  let to: CommitmentState;
  switch (a.operation) {
    case "authorize":
      to = { type: "Accepted" };
      mapped.push({ field: "operation", note: "AP2 'authorize' -> Warp CommitmentState 'Accepted' (the commitment becomes a firm agreement). Warp checks the move is legal; it does not perform or validate the authorization." });
      break;
    case "refund": {
      const amount = moneyFromMinor(a.amount_minor, a.currency);
      to = { type: "Refunded", amount, at: a.at };
      mapped.push({ field: "operation", note: "AP2 'refund' -> Warp CommitmentState 'Refunded'." });
      mapped.push(amountNote("amount_minor", a.amount_minor, amount));
      break;
    }
    case "capture":
      return gap(
        "A 'capture' moves funds; it is not a commitment state change.",
        "Payment execution is the authorization/payment layer's concern. Warp models the money leg as a Fulfillment, while guard_action moves commitment state — so there is no commitment transition to check for a capture.",
      );
    default:
      return gap(`Unrecognized operation '${a.operation}'.`, "Express the move as a Warp CommitmentState directly and use guard_action.");
  }

  return {
    ok: true,
    protocol: "ap2",
    action: { commitment: a.commitment_ref, to, actor: a.actor, ...(a.reason !== undefined ? { reason: a.reason } : {}) },
    mapped,
    outOfScope,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Map any supported protocol-shaped action onto a Warp `ProposedAction`.
 *
 * Pure: no I/O, no clock, no mutation. Total: every input returns either a
 * mapping or an explicit gap — it never throws for an unmappable action, because
 * "this does not map" is an answer the caller needs, not an error.
 */
export function mapProtocolAction(input: ProtocolAction): MappingResult {
  switch (input.protocol) {
    case "acp":
      return fromAcpAction(input.action);
    case "ucp":
      return fromUcpAction(input.action);
    case "ap2":
      return fromAp2Action(input.action);
  }
}
