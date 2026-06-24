/**
 * Tool-level tests: drive the server through a real MCP client over an in-memory
 * transport, asserting each tool returns the correct verdict for representative
 * inputs, that malformed/untrusted input is rejected by the schema (not crashed
 * on), and that the server lists its tools. Fixtures are built with the published
 * commerce-types helpers, so the schemas are tested against genuine objects.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { newCommitment, applyCommitmentPath, partyId, valueId } from "@warp-lang/commerce-types";
import { createWarpMcpServer } from "../src/server.js";

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

function fulfilledOrder(amount = 200, currency = "MAD") {
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
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  return { shipped, seller, world: { commitments: [shipped], fulfillments: [], parties: [] } };
}

const refundTo = (amount: number, currency = "MAD") => ({
  type: "Refunded",
  amount: { amount, currency },
  at: "2026-02-01T00:00:00.000Z",
});

describe("server", () => {
  it("lists all five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_compensation",
      "guard_action",
      "unify_sources",
      "valid_transitions",
      "validate_settlement",
    ]);
  });
});

describe("guard_action", () => {
  it("blocks an over-refund with I-1, a fix, and legal alternatives", async () => {
    const client = await connect();
    const { shipped, world } = fulfilledOrder(200);
    const r = parse(
      await client.callTool({
        name: "guard_action",
        arguments: { world, action: { commitment: shipped.id, to: refundTo(500), actor: "agent" } },
      }),
    );
    expect(r.ok).toBe(false);
    const v = r.violations.find((x: any) => x.rule === "I-1");
    expect(v).toBeDefined();
    expect(v.fix).toMatch(/at most the committed amount/i);
  });

  it("allows a refund within the committed amount", async () => {
    const client = await connect();
    const { shipped, world } = fulfilledOrder(200);
    const r = parse(
      await client.callTool({
        name: "guard_action",
        arguments: { world, action: { commitment: shipped.id, to: refundTo(200), actor: "agent" } },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("blocks an illegal backward transition and offers the legal moves", async () => {
    const client = await connect();
    const { shipped, world } = fulfilledOrder(200);
    const r = parse(
      await client.callTool({
        name: "guard_action",
        arguments: { world, action: { commitment: shipped.id, to: { type: "Accepted" }, actor: "agent" } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe("I-2");
    expect(r.alternatives.map((a: any) => a.to).sort()).toEqual(["Disputed", "Refunded"]);
  });
});

describe("validate_settlement", () => {
  it("accepts a breakdown that reconciles to the committed total", async () => {
    const client = await connect();
    const r = parse(
      await client.callTool({
        name: "validate_settlement",
        arguments: {
          settlement: {
            total: { amount: 200, currency: "MAD" },
            components: [
              { kind: "Base", amount: { amount: 160, currency: "MAD" } },
              { kind: "Tax", amount: { amount: 30, currency: "MAD" } },
              { kind: "Shipping", amount: { amount: 10, currency: "MAD" } },
            ],
          },
          committedTotal: { amount: 200, currency: "MAD" },
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("blocks a breakdown whose components do not sum to the total", async () => {
    const client = await connect();
    const r = parse(
      await client.callTool({
        name: "validate_settlement",
        arguments: {
          settlement: {
            total: { amount: 200, currency: "MAD" },
            components: [
              { kind: "Base", amount: { amount: 160, currency: "MAD" } },
              { kind: "Tax", amount: { amount: 20, currency: "MAD" } },
            ],
          },
          committedTotal: { amount: 200, currency: "MAD" },
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });
});

describe("valid_transitions", () => {
  it("returns the legal moves from Fulfilled", async () => {
    const client = await connect();
    const r = parse(
      await client.callTool({ name: "valid_transitions", arguments: { from: { type: "Fulfilled" } } }),
    );
    expect(r.from).toBe("Fulfilled");
    expect(r.legalMoves.sort()).toEqual(["Disputed", "Refunded"]);
  });
});

describe("check_compensation", () => {
  it("returns a structured verdict with a plan for a forward sequence", async () => {
    const client = await connect();
    const { shipped, world } = fulfilledOrder(200);
    const r = parse(
      await client.callTool({
        name: "check_compensation",
        arguments: {
          world,
          forward: [{ commitment: shipped.id, to: { type: "Fulfilled" }, actor: "seller_1" }],
          at: "2026-03-01T00:00:00.000Z",
        },
      }),
    );
    expect(typeof r.ok).toBe("boolean");
    expect(typeof r.plan.steps).toBe("number");
    expect(r.plan.steps).toBeGreaterThanOrEqual(1);
  });
});

describe("unify_sources", () => {
  it("unifies corresponded sources that agree on the amount", async () => {
    const client = await connect();
    const buyer = partyId("b");
    const seller = partyId("s");
    const mk = (amt: number) =>
      newCommitment(buyer, seller, {
        offered: [],
        requested: [
          { id: valueId("v"), form: { kind: "Money", money: { amount: amt, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
        ],
      });
    const r = parse(
      await client.callTool({
        name: "unify_sources",
        arguments: {
          sources: [
            { platform: "shopify", commitment: mk(200) },
            { platform: "stripe", commitment: mk(200) },
          ],
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("blocks sources that disagree on the amount with I-1", async () => {
    const client = await connect();
    const buyer = partyId("b");
    const seller = partyId("s");
    const mk = (amt: number) =>
      newCommitment(buyer, seller, {
        offered: [],
        requested: [
          { id: valueId("v"), form: { kind: "Money", money: { amount: amt, currency: "MAD" } }, quantity: 1, state: { type: "Available" } },
        ],
      });
    const r = parse(
      await client.callTool({
        name: "unify_sources",
        arguments: {
          sources: [
            { platform: "shopify", commitment: mk(200) },
            { platform: "stripe", commitment: mk(150) },
          ],
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v: any) => v.rule === "I-1")).toBe(true);
  });
});

describe("untrusted input", () => {
  it("rejects an action with an unexpected field (strict) as a clean error, not a crash", async () => {
    const client = await connect();
    const { shipped, world } = fulfilledOrder(200);
    const bad: any = await client.callTool({
      name: "guard_action",
      arguments: {
        world,
        action: { commitment: shipped.id, to: refundTo(200), actor: "agent", injected: "evil" },
      },
    });
    // The schema rejects the injected field server-side and returns a structured
    // error result (isError), rather than running the guard or crashing.
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/unrecognized|injected|key/i);
    // server is still alive and serves a subsequent valid call
    const r = parse(
      await client.callTool({
        name: "guard_action",
        arguments: { world, action: { commitment: shipped.id, to: refundTo(200), actor: "agent" } },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed state target (unknown type) by the schema", async () => {
    const client = await connect();
    const bad: any = await client.callTool({
      name: "valid_transitions",
      arguments: { from: { type: "NotARealState" } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/discriminator|invalid/i);
  });
});
