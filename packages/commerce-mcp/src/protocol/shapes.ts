/**
 * The protocol-side action shapes the bridge accepts.
 *
 * WHAT THESE ARE. Each schema below is a REPRESENTATIVE, MINIMAL subset of the
 * fields an agentic-commerce protocol carries on the action it is about to
 * commit — enough to decide the Warp question ("is this a coherent commerce
 * move?") and no more. They are defined HERE, on Warp's side, for Warp's own
 * adapters to read.
 *
 * WHAT THESE ARE NOT. They are not those protocols' normative wire schemas, not
 * generated from their specifications, and not a claim to implement them. A
 * caller integrating a real protocol maps its payload onto one of these shapes;
 * the shape is Warp's input contract, not the protocol's output contract. Nothing
 * here asserts that any protocol, or its maintainers, has adopted, integrated,
 * endorsed, or reviewed Warp.
 *
 * Every schema is `.strict()`: these are AGENT-AUTHORED action payloads (what the
 * agent proposes to do), so an unexpected key is a malformed proposal and is
 * rejected — the same tier discipline `schemas.ts` documents.
 *
 * MONEY IS IN MINOR UNITS. Each shape takes integer minor units (cents, fils),
 * because that is how these protocols and their PSPs carry amounts. The adapters
 * convert to Warp `Money` using the published `currencyDecimals`, so a
 * zero-decimal currency (JPY) and a three-decimal one (TND) are handled by the
 * package's own table rather than an assumption of 100.
 *
 * FIELDS WARP DOES NOT INTERPRET. Several optional fields below exist so that a
 * realistic payload round-trips through the bridge without being rejected, and so
 * the adapter can NAME them in its `outOfScope` notes. Warp reads them only to
 * report that it did not use them. They stay the concern of the protocol that
 * defines them.
 */
import { z } from "zod";

/** The protocols the bridge ships adapters for. */
export const PROTOCOL_IDS = ["acp", "ucp", "ap2"] as const;

/** A protocol the bridge can map from. */
export type ProtocolId = (typeof PROTOCOL_IDS)[number];

export const ProtocolIdSchema = z.enum(PROTOCOL_IDS);

/** An integer amount in a currency's minor unit (cents, fils, …). */
const minorAmount = z.number().int();

// ---------------------------------------------------------------------------
// ACP-shaped action — checkout and post-purchase order status.
// ---------------------------------------------------------------------------

/**
 * A checkout-layer action: a checkout session or an order moving to a new status.
 * `status` is carried as the protocol spells it (snake_case, e.g.
 * `ready_for_payment`); the adapter maps it to a Warp `CommitmentState` and
 * reports a gap when a status has no sound Warp counterpart.
 */
export const AcpActionSchema = z
  .object({
    /** Which object is moving — a pre-purchase checkout session, or a placed order. */
    object: z.enum(["checkout_session", "order"]),
    /**
     * The object's id. The caller ASSERTS this corresponds to a commitment in
     * `world`; the bridge does not infer correspondence (same discipline as
     * `unify_sources`).
     */
    id: z.string().min(1),
    /** The status this action would move the object to. */
    status: z.string().min(1),
    /** ISO-4217 currency of `amount_minor`. */
    currency: z.string().min(1),
    /** Amount in minor units. Required for a refund; ignored otherwise. */
    amount_minor: minorAmount.optional(),
    /** Who is proposing the action. */
    actor: z.string().min(1),
    /** ISO-8601 instant the action occurs at. */
    at: z.string().min(1),
    /** Free-text reason, recorded on states that carry one (Cancelled, Disputed). */
    reason: z.string().optional(),

    // --- Fields Warp reads only to report that it did not interpret them. ---
    /** PSP / capture configuration. Payment execution is not Warp's layer. */
    payment_provider: z.string().optional(),
    /** Tax configuration. Warp reconciles supplied amounts; it does not compute tax. */
    tax: z.unknown().optional(),
    /** Fulfillment/shipping detail. */
    fulfillment: z.unknown().optional(),
    /** Fraud / risk signals. Warp does not model fraud. */
    risk: z.unknown().optional(),
  })
  .strict();

export type AcpAction = z.infer<typeof AcpActionSchema>;

// ---------------------------------------------------------------------------
// UCP-shaped action — discovery and cart, then the handoff to an order.
// ---------------------------------------------------------------------------

/**
 * A discovery/cart-layer action. Cart mutations are deliberately representable
 * here even though they do NOT map to a Warp commitment action — the adapter
 * returns an explicit mapping gap for them rather than silently inventing a
 * commitment, because a cart is pre-commitment (Warp's `Intent`) and
 * `guard_action` operates on commitments.
 */
export const UcpActionSchema = z
  .object({
    /** Which object is moving — a pre-purchase cart, or a placed order. */
    object: z.enum(["cart", "order"]),
    /** The object's id; correspondence to a commitment in `world` is the caller's assertion. */
    id: z.string().min(1),
    /** The cart/order operation being proposed. */
    operation: z.enum([
      "add_item",
      "update_item",
      "remove_item",
      "checkout",
      "place_order",
      "cancel",
    ]),
    /** ISO-4217 currency of `total_minor`. */
    currency: z.string().min(1),
    /** Order total in minor units, when the operation carries one. */
    total_minor: minorAmount.optional(),
    /** Who is proposing the action. */
    actor: z.string().min(1),
    /** ISO-8601 instant the action occurs at. */
    at: z.string().min(1),
    /** Free-text reason, recorded on states that carry one. */
    reason: z.string().optional(),

    // --- Fields Warp reads only to report that it did not interpret them. ---
    /** The merchant the cart belongs to. */
    merchant_id: z.string().optional(),
    /** Catalog / product-feed reference. Discovery is not Warp's layer. */
    catalog_ref: z.string().optional(),
  })
  .strict();

export type UcpAction = z.infer<typeof UcpActionSchema>;

// ---------------------------------------------------------------------------
// AP2-shaped action — a spending action taken under a payment mandate.
// ---------------------------------------------------------------------------

/**
 * A payment-authorization-layer action: an operation performed under a mandate
 * the user granted.
 *
 * The mandate itself — whether it is validly signed, still in its window, granted
 * by the right user, and within its cap — is the AUTHORIZATION question, and it is
 * NOT Warp's. The adapter maps only the commerce move the mandate would set in
 * motion, and names the mandate fields it did not evaluate.
 */
export const Ap2ActionSchema = z
  .object({
    /** Whether the mandate covers an open-ended intent or one specific cart. */
    mandate_type: z.enum(["intent", "cart"]),
    /** The mandate's id — carried through to the notes, never evaluated. */
    mandate_id: z.string().min(1),
    /**
     * The commitment this mandate would move. Correspondence is the caller's
     * assertion; the bridge does not infer it.
     */
    commitment_ref: z.string().min(1),
    /** The payment operation proposed under the mandate. */
    operation: z.enum(["authorize", "capture", "refund"]),
    /** ISO-4217 currency of the amounts. */
    currency: z.string().min(1),
    /** The operation's amount, in minor units. */
    amount_minor: minorAmount,
    /**
     * The mandate's spending cap, in minor units. Carried so the adapter can
     * report that Warp did NOT enforce it — a cap is an authorization constraint,
     * not one of Warp's six invariants.
     */
    max_amount_minor: minorAmount.optional(),
    /** Who is proposing the action. */
    actor: z.string().min(1),
    /** ISO-8601 instant the action occurs at. */
    at: z.string().min(1),
    /** Free-text reason, recorded on states that carry one. */
    reason: z.string().optional(),

    // --- Fields Warp reads only to report that it did not interpret them. ---
    /** The signed credential proving the mandate. Signature verification is AP2's job. */
    credential: z.unknown().optional(),
  })
  .strict();

export type Ap2Action = z.infer<typeof Ap2ActionSchema>;

/** Any protocol-shaped action the bridge accepts, tagged by its protocol. */
export type ProtocolAction =
  | { protocol: "acp"; action: AcpAction }
  | { protocol: "ucp"; action: UcpAction }
  | { protocol: "ap2"; action: Ap2Action };
