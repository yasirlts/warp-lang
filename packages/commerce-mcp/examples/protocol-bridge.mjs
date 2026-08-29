/**
 * Demo: the integrity gate the agentic-commerce protocols leave open.
 *
 *   npm run build && node examples/protocol-bridge.mjs
 *
 * An agent is driving a purchase through an agentic-commerce stack: something
 * discovers and builds the cart, something runs checkout, something authorizes
 * the payment. None of those layers answers "is this coherent commerce?" — they
 * say so themselves, leaving capture semantics, returns, tax and fraud with the
 * merchant's existing systems.
 *
 * So before each action commits, the agent asks Warp, over MCP, using the shape
 * the protocol already gave it. Warp maps the action onto its own model and runs
 * the unmodified guard. It answers only its own question: it does not authorize,
 * check out, settle, or judge fraud.
 *
 * The run below shows four things an agent needs to be able to tell apart:
 *   1. a coherent action cleared;
 *   2. an incoherent one BLOCKED, with the invariant, the reason and the fix;
 *   3. an action Warp cannot map — NO verdict, which is not an approval;
 *   4. an action the payment layer would wave through that Warp still blocks.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "../dist/index.js");
const AT = "2026-02-01T00:00:00.000Z";

const parse = (r) => JSON.parse(r.content[0].text);
const rule = (v) => v.violations?.[0]?.rule ?? "?";
const hr = (t) => console.log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);

/** A shipped order committed at 200 MAD — what the agent read from its system. */
function shippedOrder() {
  const buyer = partyId("buyer_1");
  const seller = partyId("seller_1");
  const order = newCommitment(buyer, seller, {
    offered: [],
    requested: [
      {
        id: "value:order-total",
        form: { kind: "Money", money: { amount: 200, currency: "MAD" } },
        quantity: 1,
        state: { type: "Available" },
      },
    ],
  });
  return applyCommitmentPath(order, { type: "Fulfilled" }, seller);
}

async function main() {
  const transport = new StdioClientTransport({ command: "node", args: [serverEntry] });
  const client = new Client({ name: "protocol-bridge-demo", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Warp MCP tools:", tools.map((t) => t.name).join(", "));

  const order = shippedOrder();
  const world = { commitments: [order], fulfillments: [], parties: [] };
  const ask = async (protocol, action) =>
    parse(await client.callTool({ name: "guard_protocol_action", arguments: { protocol, world, action } }));

  // ─── 1. A checkout-layer refund, over the committed amount ────────────────
  hr("1. Checkout-shaped action (ACP-style): refund 500 MAD on a 200 MAD order");
  const over = await ask("acp", {
    object: "order", id: order.id, status: "refunded",
    currency: "MAD", amount_minor: 50000, actor: "support_agent", at: AT,
    payment_provider: "psp_x", tax: { rate: 0.2 }, risk: { score: 3 },
  });
  console.log(`mapped: ${over.mapped}  ->  ${over.action.to.type} ${over.action.to.amount.amount} ${over.action.to.amount.currency}`);
  console.log(`verdict: BLOCKED [${rule(over.verdict)}]`);
  console.log(`   why: ${over.verdict.violations[0].message}`);
  console.log(`   fix: ${over.verdict.violations[0].fix}`);
  console.log("   Warp read, and did not interpret:");
  for (const n of over.notes.outOfScope.filter((n) => n.field !== "(layer)")) {
    console.log(`     - ${n.field}: ${n.note}`);
  }
  if (over.verdict.ok) throw new Error("expected the over-refund to be blocked");

  // ─── 2. The agent self-corrects ───────────────────────────────────────────
  hr("2. The agent corrects the amount and re-asks");
  const fixed = await ask("acp", {
    object: "order", id: order.id, status: "refunded",
    currency: "MAD", amount_minor: 20000, actor: "support_agent", at: AT,
  });
  console.log(`refund 200 MAD -> ${fixed.verdict.ok ? "ok (structurally coherent)" : "BLOCKED"}`);
  if (!fixed.verdict.ok) throw new Error("expected the corrected refund to clear");

  // The bridge added nothing: the same mapped action through the plain tool.
  const direct = parse(
    await client.callTool({ name: "guard_action", arguments: { world, action: fixed.action } }),
  );
  console.log(`same action via plain guard_action -> ok: ${direct.ok}  (identical verdict; the bridge only did the mapping)`);
  if (direct.ok !== fixed.verdict.ok) throw new Error("bridge and guard_action disagreed");

  // ─── 3. An action Warp cannot map ─────────────────────────────────────────
  hr("3. Cart-shaped action (UCP-style): add an item to a cart");
  const cart = await ask("ucp", {
    object: "cart", id: "cart_1", operation: "add_item",
    currency: "MAD", actor: "shopping_agent", at: AT, catalog_ref: "feed/sku-9",
  });
  console.log(`mapped: ${cart.mapped}   verdict: ${cart.verdict}`);
  console.log(`   gap: ${cart.gap.reason}`);
  console.log(`   owner: ${cart.gap.owner}`);
  console.log("   NOTE: a null verdict is NOT an approval — Warp checked nothing here.");
  if (cart.verdict !== null) throw new Error("expected no verdict for a cart mutation");

  // ─── 4. An illegal state move the cart layer would happily send ───────────
  hr("4. Cart-shaped action (UCP-style): place an order that already shipped");
  const illegal = await ask("ucp", {
    object: "order", id: order.id, operation: "place_order",
    currency: "MAD", actor: "shopping_agent", at: AT,
  });
  console.log(`verdict: BLOCKED [${rule(illegal.verdict)}]`);
  console.log(`   why: ${illegal.verdict.violations[0].message}`);
  console.log(`   legal moves instead: ${illegal.verdict.alternatives.map((a) => a.to).join(", ")}`);
  if (illegal.verdict.ok) throw new Error("expected the illegal move to be blocked");

  // ─── 5. Within the mandate, still incoherent ──────────────────────────────
  hr("5. Payment-shaped action (AP2-style): refund 500 MAD under a 900 MAD mandate");
  const mandated = await ask("ap2", {
    mandate_type: "cart", mandate_id: "mandate_7", commitment_ref: order.id,
    operation: "refund", currency: "MAD", amount_minor: 50000, max_amount_minor: 90000,
    actor: "payment_agent", at: AT, credential: { jws: "<signed>" },
  });
  console.log("The mandate's 900 MAD cap is satisfied, so the payment layer would proceed.");
  console.log(`Warp: BLOCKED [${rule(mandated.verdict)}] — the order was only committed at 200 MAD.`);
  console.log(`   ${mandated.notes.outOfScope.find((n) => n.field === "max_amount_minor").note}`);
  if (mandated.verdict.ok) throw new Error("expected the over-refund to be blocked under the mandate too");

  hr("Where this sits");
  console.log(
    "Warp answered one question — is this internally coherent commerce? — and blocked two\n" +
      "actions the surrounding layers had no reason to stop. Discovery, checkout, and payment\n" +
      "authorization remain the job of the protocols that own them; Warp runs beneath them and\n" +
      "does not authorize, check out, settle, or assess fraud. Nothing here implies those\n" +
      "protocols or their maintainers have adopted, integrated, or endorsed Warp — this is an\n" +
      "integration capability on Warp's side.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
