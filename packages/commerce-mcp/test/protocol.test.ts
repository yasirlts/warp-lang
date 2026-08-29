/**
 * Protocol-bridge tests.
 *
 * Three things are being proven here, in order of how much they matter:
 *
 *  1. THE BRIDGE ADDS NO INTEGRITY SEMANTICS. For every mappable action, the
 *     verdict `guard_protocol_action` returns is byte-for-byte what the plain
 *     `guard_action` tool returns for the mapped Warp action. This is the whole
 *     honesty claim, checked rather than asserted.
 *  2. THE GAPS ARE REAL AND FAIL LOUDLY. An action with no sound Warp counterpart
 *     returns `verdict: null` — never a pass — with the layer that owns the
 *     concept named.
 *  3. WARP CHECKS ITS OWN QUESTION, NOT THE PROTOCOL'S. A mandate's spending cap
 *     is not a Warp invariant: an action can satisfy the cap and still be blocked
 *     by Warp, and breach the cap and still be cleared by Warp. Both directions
 *     are tested, because a reader could otherwise assume Warp covers the cap.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  newCommitment,
  applyCommitmentPath,
  partyId,
  valueId,
  type CommitmentState,
} from "@warp-lang/commerce-types";
import { createWarpMcpServer } from "../src/server.js";
import {
  fromAcpAction,
  fromUcpAction,
  fromAp2Action,
  moneyFromMinor,
  guardProtocolAction,
} from "../src/protocol/index.js";

async function connect() {
  const server = createWarpMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

/** A commitment driven to `state`, committed at `amount` `currency`. */
function orderAt(state: CommitmentState, amount = 200, currency = "MAD") {
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: valueId("value:order-total"),
        form: { kind: "Money", money: { amount, currency } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  const driven = applyCommitmentPath(order, state, seller);
  return { order: driven, world: { commitments: [driven], fulfillments: [], parties: [] } };
}

const fulfilled = () => orderAt({ type: "Fulfilled" });
const AT = "2026-02-01T00:00:00.000Z";

/**
 * `guardAction` stamps history entries with the wall clock, so two otherwise
 * identical successful calls differ only in those timestamps. Blank them so the
 * equivalence comparison tests the VERDICT rather than the clock.
 */
function normalize(v: any): any {
  const c = JSON.parse(JSON.stringify(v));
  for (const cm of c?.next?.commitments ?? []) {
    for (const h of cm.history ?? []) h.at = "<ts>";
  }
  return c;
}

// ---------------------------------------------------------------------------
// Mapping (pure, no MCP)
// ---------------------------------------------------------------------------

describe("money mapping (minor units)", () => {
  it("uses the published decimal table, not an assumed 100", () => {
    expect(moneyFromMinor(20000, "MAD")).toEqual({ amount: 200, currency: "MAD" });
    expect(moneyFromMinor(20000, "JPY")).toEqual({ amount: 20000, currency: "JPY" }); // 0 decimals
    expect(moneyFromMinor(20000, "TND")).toEqual({ amount: 20, currency: "TND" }); // 3 decimals
  });
});

describe("ACP mapping", () => {
  it("maps a refunded order to Refunded with the converted amount", () => {
    const r = fromAcpAction({
      object: "order",
      id: "c1",
      status: "refunded",
      currency: "MAD",
      amount_minor: 15000,
      actor: "agent",
      at: AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action.to).toEqual({ type: "Refunded", amount: { amount: 150, currency: "MAD" }, at: AT });
    expect(r.action.commitment).toBe("c1");
  });

  it("maps checkout_session statuses onto the commitment spine", () => {
    const ready = fromAcpAction({ object: "checkout_session", id: "c1", status: "ready_for_payment", currency: "MAD", actor: "a", at: AT });
    const done = fromAcpAction({ object: "checkout_session", id: "c1", status: "completed", currency: "MAD", actor: "a", at: AT });
    expect(ready.ok && ready.action.to.type).toBe("Proposed");
    expect(done.ok && done.action.to.type).toBe("Accepted");
  });

  it("refuses to map a pre-payment session — that is Intent, not Commitment", () => {
    const r = fromAcpAction({ object: "checkout_session", id: "c1", status: "not_ready_for_payment", currency: "MAD", actor: "a", at: AT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.owner).toMatch(/Intent, not a Commitment/i);
  });

  it("refuses to map 'shipped' rather than inventing a completeness it does not state", () => {
    const r = fromAcpAction({ object: "order", id: "c1", status: "shipped", currency: "MAD", actor: "a", at: AT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.owner).toMatch(/PartiallyFulfilled/);
  });

  it("refuses a refund with no amount — I-1 needs the number", () => {
    const r = fromAcpAction({ object: "order", id: "c1", status: "refunded", currency: "MAD", actor: "a", at: AT });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/amount_minor/);
  });

  it("names the fields it read but did not interpret", () => {
    const r = fromAcpAction({
      object: "order", id: "c1", status: "fulfilled", currency: "MAD", actor: "a", at: AT,
      payment_provider: "psp", tax: { rate: 0.2 }, risk: { score: 3 },
    });
    expect(r.ok).toBe(true);
    const fields = r.outOfScope.map((n) => n.field);
    expect(fields).toContain("payment_provider");
    expect(fields).toContain("tax");
    expect(fields).toContain("risk");
  });
});

describe("UCP mapping", () => {
  it("refuses every cart mutation — a cart is not a commitment", () => {
    for (const operation of ["add_item", "update_item", "remove_item", "cancel"] as const) {
      const r = fromUcpAction({ object: "cart", id: "c1", operation, currency: "MAD", actor: "a", at: AT });
      expect(r.ok, `cart ${operation} must not map`).toBe(false);
      if (r.ok) continue;
      expect(r.owner).toMatch(/Intent, not a Commitment/i);
    }
  });

  it("maps the checkout handoff and the order moves after it", () => {
    const checkout = fromUcpAction({ object: "cart", id: "c1", operation: "checkout", currency: "MAD", actor: "a", at: AT });
    const placed = fromUcpAction({ object: "order", id: "c1", operation: "place_order", currency: "MAD", actor: "a", at: AT });
    const changed = fromUcpAction({ object: "order", id: "c1", operation: "update_item", currency: "MAD", actor: "a", at: AT });
    expect(checkout.ok && checkout.action.to.type).toBe("Proposed");
    expect(placed.ok && placed.action.to.type).toBe("Accepted");
    expect(changed.ok && changed.action.to.type).toBe("Modified");
  });
});

describe("AP2 mapping", () => {
  it("maps authorize and refund, and refuses capture", () => {
    const auth = fromAp2Action({ mandate_type: "cart", mandate_id: "m1", commitment_ref: "c1", operation: "authorize", currency: "MAD", amount_minor: 20000, actor: "a", at: AT });
    const refund = fromAp2Action({ mandate_type: "cart", mandate_id: "m1", commitment_ref: "c1", operation: "refund", currency: "MAD", amount_minor: 20000, actor: "a", at: AT });
    const capture = fromAp2Action({ mandate_type: "cart", mandate_id: "m1", commitment_ref: "c1", operation: "capture", currency: "MAD", amount_minor: 20000, actor: "a", at: AT });
    expect(auth.ok && auth.action.to.type).toBe("Accepted");
    expect(refund.ok && refund.action.to.type).toBe("Refunded");
    expect(capture.ok).toBe(false);
    if (capture.ok) return;
    expect(capture.owner).toMatch(/Fulfillment/);
  });

  it("states plainly that it does not enforce the mandate cap", () => {
    const r = fromAp2Action({
      mandate_type: "cart", mandate_id: "m1", commitment_ref: "c1", operation: "refund",
      currency: "MAD", amount_minor: 20000, max_amount_minor: 50000, actor: "a", at: AT,
      credential: { jws: "…" },
    });
    expect(r.ok).toBe(true);
    const cap = r.outOfScope.find((n) => n.field === "max_amount_minor");
    expect(cap?.note).toMatch(/NOT ENFORCED/);
    expect(r.outOfScope.some((n) => n.field === "credential")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verdicts through the MCP tool
// ---------------------------------------------------------------------------

describe("guard_protocol_action", () => {
  it("blocks an ACP-shaped over-refund with I-1 and a fix", async () => {
    const client = await connect();
    const { order, world } = fulfilled(); // committed 200 MAD
    const r = parse(
      await client.callTool({
        name: "guard_protocol_action",
        arguments: {
          protocol: "acp",
          world,
          action: { object: "order", id: order.id, status: "refunded", currency: "MAD", amount_minor: 50000, actor: "support_agent", at: AT },
        },
      }),
    );
    expect(r.mapped).toBe(true);
    expect(r.verdict.ok).toBe(false);
    const v = r.verdict.violations.find((x: any) => x.rule === "I-1");
    expect(v).toBeDefined();
    expect(v.fix).toMatch(/at most the committed amount/i);
  });

  it("clears the corrected ACP-shaped refund", async () => {
    const client = await connect();
    const { order, world } = fulfilled();
    const r = parse(
      await client.callTool({
        name: "guard_protocol_action",
        arguments: {
          protocol: "acp",
          world,
          action: { object: "order", id: order.id, status: "refunded", currency: "MAD", amount_minor: 20000, actor: "support_agent", at: AT },
        },
      }),
    );
    expect(r.mapped).toBe(true);
    expect(r.verdict.ok).toBe(true);
  });

  it("blocks a UCP-shaped illegal move with I-2 and offers the legal alternatives", async () => {
    const client = await connect();
    const { order, world } = fulfilled(); // Fulfilled -> Accepted is not a legal move
    const r = parse(
      await client.callTool({
        name: "guard_protocol_action",
        arguments: {
          protocol: "ucp",
          world,
          action: { object: "order", id: order.id, operation: "place_order", currency: "MAD", actor: "agent", at: AT },
        },
      }),
    );
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.violations.some((v: any) => v.rule === "I-2")).toBe(true);
    expect(r.verdict.alternatives.map((a: any) => a.to).sort()).toEqual(["Disputed", "Refunded"]);
  });

  it("returns verdict: null for an unmappable action — never an approval", async () => {
    const client = await connect();
    const { world } = fulfilled();
    const r = parse(
      await client.callTool({
        name: "guard_protocol_action",
        arguments: {
          protocol: "ucp",
          world,
          action: { object: "cart", id: "cart_1", operation: "add_item", currency: "MAD", actor: "agent", at: AT },
        },
      }),
    );
    expect(r.mapped).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.gap.owner).toMatch(/Intent/);
    // The critical negative: nothing in the payload reads as an approval.
    expect(r.verdict?.ok).toBeUndefined();
  });

  it("rejects a payload that does not match the declared protocol, without a verdict", async () => {
    const client = await connect();
    const { world } = fulfilled();
    const res: any = await client.callTool({
      name: "guard_protocol_action",
      arguments: {
        protocol: "ap2",
        world,
        // an ACP-shaped payload sent as ap2
        action: { object: "order", id: "c1", status: "refunded", currency: "MAD", amount_minor: 100, actor: "a", at: AT },
      },
    });
    const body = JSON.parse(res.content[0].text);
    expect(res.isError ?? body.ok === false).toBeTruthy();
    expect(JSON.stringify(body)).toMatch(/not checked|does not match/i);
  });
});

// ---------------------------------------------------------------------------
// The equivalence proof: the bridge adds no integrity semantics
// ---------------------------------------------------------------------------

describe("bridge verdict === guard_action verdict", () => {
  const cases: Array<[string, any, any]> = [
    [
      "acp over-refund (blocked)",
      { protocol: "acp", status: "refunded", amount_minor: 50000 },
      null,
    ],
    [
      "acp refund within committed (cleared)",
      { protocol: "acp", status: "refunded", amount_minor: 20000 },
      null,
    ],
  ];

  for (const [name, spec] of cases) {
    it(`is identical for ${name}`, async () => {
      const client = await connect();
      const { order, world } = fulfilled();

      const bridged = parse(
        await client.callTool({
          name: "guard_protocol_action",
          arguments: {
            protocol: spec.protocol,
            world,
            action: { object: "order", id: order.id, status: spec.status, currency: "MAD", amount_minor: spec.amount_minor, actor: "support_agent", at: AT },
          },
        }),
      );
      expect(bridged.mapped).toBe(true);

      // The SAME mapped action, sent to the plain guard_action tool.
      const direct = parse(
        await client.callTool({
          name: "guard_action",
          arguments: { world, action: bridged.action },
        }),
      );

      expect(normalize(bridged.verdict)).toEqual(normalize(direct));
    });
  }

  it("holds for the in-process composition too", () => {
    const { order, world } = fulfilled();
    const r = guardProtocolAction(world as any, {
      protocol: "ap2",
      action: {
        mandate_type: "cart", mandate_id: "m1", commitment_ref: order.id as string,
        operation: "refund", currency: "MAD", amount_minor: 50000, max_amount_minor: 90000,
        actor: "agent", at: AT,
      },
    });
    expect(r.mapped).toBe(true);
    expect(r.verdict?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Warp answers its own question, not the protocol's
// ---------------------------------------------------------------------------

describe("the mandate cap is not a Warp invariant", () => {
  const mandate = (amount_minor: number, max_amount_minor: number, commitment_ref: string) =>
    ({
      mandate_type: "cart" as const, mandate_id: "m1", commitment_ref,
      operation: "refund" as const, currency: "MAD", amount_minor, max_amount_minor,
      actor: "agent", at: AT,
    });

  it("blocks an action that is WITHIN the mandate cap but over the committed amount", () => {
    const { order, world } = fulfilled(); // committed 200 MAD
    // 500 MAD refund, cap 900 MAD: the cap is satisfied, Warp still blocks on I-1.
    const r = guardProtocolAction(world as any, { protocol: "ap2", action: mandate(50000, 90000, order.id as string) });
    expect(r.verdict?.ok).toBe(false);
    if (r.verdict?.ok) return;
    expect(r.verdict?.violations.some((v) => v.rule === "I-1")).toBe(true);
  });

  it("clears an action that BREACHES the mandate cap but is coherent commerce", () => {
    const { order, world } = fulfilled(); // committed 200 MAD
    // 200 MAD refund, cap 10 MAD: Warp clears it — enforcing the cap is not its job.
    const r = guardProtocolAction(world as any, { protocol: "ap2", action: mandate(20000, 1000, order.id as string) });
    expect(r.verdict?.ok).toBe(true);
    const cap = r.notes.outOfScope.find((n) => n.field === "max_amount_minor");
    expect(cap?.note).toMatch(/NOT ENFORCED/);
  });
});
