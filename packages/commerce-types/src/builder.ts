/**
 * `order()` — a fluent, high-level way to construct a history-complete, auditable
 * commerce order.
 *
 * This is a CONVENIENCE layer, not a new code path. Every object it produces is
 * built from the same public constructors and transition functions a power user
 * would call by hand:
 *
 *   - `newCommitment` / `newFulfillment` / `newIntent` create the primitives;
 *   - `applyCommitmentPath` / `applyFulfillmentPath` replay the canonical path
 *     through `transitionCommitment` / `transitionFulfillment`, so every state
 *     the order reaches has a REAL, valid, append-only history — never a
 *     fabricated `{...obj, state}` shortcut.
 *
 * The result therefore passes `auditCommerce` exactly as a hand-built object
 * does. The builder makes a correct order EASY to construct; it does not make an
 * incorrect one impossible — invalid compositions are surfaced as
 * `{ ok: false, error }`, never silently coerced into a broken object.
 */

import {
  auditCommerce,
  type InvariantViolation,
} from "./invariants.js";
import { isMoney } from "./money.js";
import type { Money } from "./money.js";
import {
  newCommitment,
  newFulfillment,
  newIntent,
  partyId,
  valueId,
} from "./primitives.js";
import type {
  Commitment,
  Fulfillment,
  Party,
  PartyCapacity,
  PartyID,
  PartyLocale,
  Value,
} from "./primitives.js";
import {
  applyCommitmentPath,
  applyFulfillmentPath,
  transitionIntent,
  type Result,
} from "./transitions.js";
import type { Intent } from "./primitives.js";

/** How far the order has progressed — drives the Commitment's target state. */
type Stage = "proposed" | "paid" | "fulfilled";

/** A single line a caller adds via `.item()` or `.value()`. */
interface Line {
  /** The money the buyer provides for this line (Commitment subject.requested). */
  money: Money;
  /** An optional offered good (Commitment subject.offered). */
  sku?: string;
  quantity: number;
}

/**
 * The output of a successful `.build()`: a history-complete set of objects plus a
 * one-call `.audit()` that runs the headline `auditCommerce` check over them.
 */
export interface AuditedOrder {
  /** The order's Commitment, driven to its target state with replayed history. */
  readonly commitment: Commitment;
  /** All commitments (today: just the one) — ready to pass to `auditCommerce`. */
  readonly commitments: Commitment[];
  /** The Fulfillment(s) — present once `.fulfilled()` was called. */
  readonly fulfillments: Fulfillment[];
  /** Buyer and seller, with the capacity the reached state implies. */
  readonly parties: Party[];
  /** The originating Intent, converted into this Commitment. */
  readonly intent: Intent;
  /** Run every applicable invariant check; an empty array means clean. */
  audit(): InvariantViolation[];
}

function localeFor(currency: string): PartyLocale {
  return { language: "en", currency: currency as PartyLocale["currency"], jurisdiction: "MA" };
}

function capacity(partial: Partial<PartyCapacity>): PartyCapacity {
  return {
    can_buy: false,
    can_sell: false,
    can_fulfill: false,
    can_guarantee: false,
    verified_at: new Date().toISOString(),
    ...partial,
  };
}

class OrderBuilder {
  private buyer?: PartyID;
  private seller?: PartyID;
  private readonly lines: Line[] = [];
  private stage: Stage = "proposed";

  /** The buyer (Commitment initiator). Accepts a PartyID or a plain string. */
  from(buyer: PartyID | string): this {
    this.buyer = typeof buyer === "string" ? partyId(buyer) : buyer;
    return this;
  }

  /** The seller (Commitment counterparty). Accepts a PartyID or a plain string. */
  to(seller: PartyID | string): this {
    this.seller = typeof seller === "string" ? partyId(seller) : seller;
    return this;
  }

  /**
   * Add an offered good priced in `price`. The buyer's side (requested) gets a
   * money line of `price × quantity`; the seller's side (offered) gets the good.
   */
  item(spec: { price: Money; sku?: string; quantity?: number }): this {
    const quantity = spec.quantity ?? 1;
    this.lines.push({
      money: { amount: spec.price.amount * quantity, currency: spec.price.currency },
      sku: spec.sku,
      quantity,
    });
    return this;
  }

  /** Add a bare money line the buyer provides (e.g. a payment with no SKU). */
  value(money: Money): this {
    this.lines.push({ money, quantity: 1 });
    return this;
  }

  /** Drive the Commitment to Accepted (payment captured / order is binding). */
  paid(): this {
    if (this.stage === "proposed") this.stage = "paid";
    return this;
  }

  /** Drive the Commitment to Fulfilled and produce a Completed Fulfillment. */
  fulfilled(): this {
    this.stage = "fulfilled";
    return this;
  }

  /**
   * Compose the order. Returns `{ ok: true, value }` with a history-complete,
   * auditable {@link AuditedOrder}, or `{ ok: false, error }` with an actionable
   * message when the composition is not a valid order.
   */
  build(): Result<AuditedOrder> {
    if (this.buyer === undefined) {
      return { ok: false, error: "An order needs a buyer — call .from(buyerId) before .build()." };
    }
    if (this.seller === undefined) {
      return { ok: false, error: "An order needs a seller — call .to(sellerId) before .build()." };
    }
    if ((this.buyer as string) === (this.seller as string)) {
      return {
        ok: false,
        error: "Buyer and seller must be different parties; a sale needs two distinct parties (Invariant 5).",
      };
    }
    if (this.lines.length === 0) {
      return {
        ok: false,
        error: "An order needs at least one value — call .item({ price }) or .value(money) before .build().",
      };
    }

    // Validate every money line, and require a single currency across the order.
    const currencies = new Set<string>();
    for (const line of this.lines) {
      if (!isMoney(line.money)) {
        return {
          ok: false,
          error: "Each line needs typed Money ({ amount, currency }); a bare number is not a valid value (Invariant 1).",
        };
      }
      if (!Number.isFinite(line.money.amount)) {
        return { ok: false, error: `Money amount must be a finite number; got ${line.money.amount}.` };
      }
      currencies.add(line.money.currency);
    }
    if (currencies.size > 1) {
      return {
        ok: false,
        error:
          `Order mixes currencies (${[...currencies].join(", ")}). Use a single currency, ` +
          `or convert() the values to one base currency first (Invariant 1: Value Conservation).`,
      };
    }
    const currency = [...currencies][0] as string;

    // Build the typed Values from the lines.
    const offered: Value[] = [];
    const requested: Value[] = [];
    for (const line of this.lines) {
      requested.push({
        id: valueId(),
        form: { kind: "Money", money: line.money },
        quantity: 1,
        state: { type: "Available" },
      });
      if (line.sku !== undefined) {
        offered.push({
          id: valueId(),
          form: { kind: "PhysicalGood", sku: line.sku, condition: "New" },
          quantity: line.quantity,
          state: { type: "Available" },
        });
      }
    }

    // The reached state has consequences: an Accepted-or-later Commitment means
    // the buyer's capacity was verified (Invariant 3). Model that honestly.
    const reachesAccepted = this.stage === "paid" || this.stage === "fulfilled";
    const buyerParty: Party = {
      id: this.buyer,
      party_type: "Individual",
      locale: localeFor(currency),
      capacity: capacity({ can_buy: reachesAccepted }),
    };
    const sellerParty: Party = {
      id: this.seller,
      party_type: "Organization",
      locale: localeFor(currency),
      capacity: capacity({ can_sell: true, can_fulfill: true }),
    };

    // Originating Intent → Converted into this Commitment (history-complete).
    const draftCommitment = newCommitment(this.buyer, this.seller, { offered, requested });

    const commitmentTarget =
      this.stage === "fulfilled"
        ? ({ type: "Fulfilled" } as const)
        : this.stage === "paid"
          ? ({ type: "Accepted" } as const)
          : ({ type: "Proposed" } as const);

    // Replay the canonical path so the history is valid by construction.
    const commitment = applyCommitmentPath(draftCommitment, commitmentTarget, this.buyer);

    // Guard against the replay fallback: if the path did not actually reach the
    // target through real transitions, surface it rather than emit a coerced
    // object. (Canonical paths from Draft are valid, so this should not happen —
    // but the builder must never paper over a model violation.)
    if (commitment.state.type !== commitmentTarget.type) {
      return {
        ok: false,
        error: `Could not drive the commitment to '${commitmentTarget.type}' through valid transitions.`,
      };
    }
    if (commitment.history.length === 0) {
      return {
        ok: false,
        error: `Reached '${commitmentTarget.type}' without a replayed history; refusing to emit an object that would fail Invariant 4.`,
      };
    }

    const intentActive = newIntent(this.buyer);
    const intentResult = transitionIntent(
      intentActive,
      { type: "Converted", commitment_id: commitment.id },
      this.buyer,
    );
    if (!intentResult.ok) {
      return { ok: false, error: intentResult.error };
    }
    const intent: Intent = { ...intentResult.value, originated_from: commitment.id };
    const linkedCommitment: Commitment = { ...commitment, originated_from: intent.id };

    // Fulfillment only exists once the order is fulfilled.
    const fulfillments: Fulfillment[] = [];
    if (this.stage === "fulfilled") {
      const planned = newFulfillment(linkedCommitment.id);
      const completed = applyFulfillmentPath(planned, { type: "Completed" }, this.seller);
      if (completed.state.type !== "Completed" || completed.history.length === 0) {
        return {
          ok: false,
          error: "Could not drive the fulfillment to 'Completed' through valid transitions.",
        };
      }
      fulfillments.push(completed);
    }

    const commitments = [linkedCommitment];
    const parties = [buyerParty, sellerParty];

    const order: AuditedOrder = {
      commitment: linkedCommitment,
      commitments,
      fulfillments,
      parties,
      intent,
      audit: () => auditCommerce(commitments, fulfillments, parties),
    };
    return { ok: true, value: order };
  }
}

/**
 * Start a fluent order. Chain `.from().to().item()/.value().paid().fulfilled()`
 * and finish with `.build()`, which returns a {@link Result}. On success, call
 * `.audit()` on the value to run the headline invariant check:
 *
 * ```ts
 * const built = order()
 *   .from("buyer_1").to("seller_1")
 *   .item({ price: { amount: 200, currency: "MAD" } })
 *   .paid().fulfilled()
 *   .build();
 * if (built.ok) {
 *   const violations = built.value.audit(); // [] === clean
 * }
 * ```
 */
export function order(): OrderBuilder {
  return new OrderBuilder();
}

export type { OrderBuilder };
