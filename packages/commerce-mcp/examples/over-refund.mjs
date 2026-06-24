/**
 * Demo: an agent asks Warp's MCP server whether a commerce action is structurally
 * coherent BEFORE that action would flow onward to payment authorization (AP2) or
 * checkout (ACP/UCP).
 *
 *   node examples/over-refund.mjs
 *
 * It spawns the real server over stdio (the same way Claude Desktop / Cursor /
 * VS Code would), connects an MCP client, lists the tools, then calls
 * `guard_action` with an over-refund — gets BLOCKED [I-1] with the fix — and
 * re-calls it with a corrected amount — gets ok. Warp confirms internal
 * coherence; it does not authorize, execute, or settle anything.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newCommitment, applyCommitmentPath, partyId } from "@warp-lang/commerce-types";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "../dist/index.js");

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function main() {
  // Spawn the Warp MCP server over stdio and connect a client to it.
  const transport = new StdioClientTransport({ command: "node", args: [serverEntry] });
  const client = new Client({ name: "demo-agent", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log("Warp MCP tools:", tools.map((t) => t.name).join(", "));
  console.log();

  // A real, shipped (Fulfilled) order committed at 200 MAD — the kind of object
  // an agent would have read from its commerce system before proposing a refund.
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
  const shipped = applyCommitmentPath(order, { type: "Fulfilled" }, seller);
  const world = { commitments: [shipped], fulfillments: [], parties: [] };

  // The agent proposes refunding 500 MAD against a 200 MAD order. Before this
  // would ever reach AP2 authorization / ACP checkout, Warp's tool checks it.
  const over = parse(
    await client.callTool({
      name: "guard_action",
      arguments: {
        world,
        action: {
          commitment: shipped.id,
          to: { type: "Refunded", amount: { amount: 500, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
          actor: "support_agent",
        },
      },
    }),
  );
  if (over.ok === false) {
    const v = over.violations.find((x) => x.rule === "I-1") ?? over.violations[0];
    console.log(`over-refund 500 MAD  -> BLOCKED [${v.rule}]`);
    console.log(`   why: ${v.message}`);
    console.log(`   fix: ${v.fix}`);
  } else {
    throw new Error("expected the over-refund to be blocked");
  }
  console.log();

  // The agent self-corrects to a refund within the committed amount.
  const fixed = parse(
    await client.callTool({
      name: "guard_action",
      arguments: {
        world,
        action: {
          commitment: shipped.id,
          to: { type: "Refunded", amount: { amount: 200, currency: "MAD" }, at: "2026-02-01T00:00:00.000Z" },
          actor: "support_agent",
        },
      },
    }),
  );
  console.log(`corrected refund 200 MAD -> ${fixed.ok ? "ok (structurally coherent)" : "BLOCKED"}`);
  console.log();
  console.log(
    "Layering: Warp validated the action is INTERNALLY COHERENT commerce. Whether the\n" +
      "corrected refund is then AUTHORIZED (AP2) and EXECUTED at checkout (ACP/UCP) is the\n" +
      "job of those protocols — Warp sits beneath them as the integrity layer.",
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
