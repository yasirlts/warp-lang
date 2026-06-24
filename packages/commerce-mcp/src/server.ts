/**
 * The Warp commerce-integrity MCP server.
 *
 * It exposes Warp's structural-coherence guardrail — value conservation, state
 * monotonicity, over-refund, settlement reconciliation, compensation validity —
 * as Model Context Protocol tools, so any MCP-capable agent can ask Warp whether
 * a commerce action is INTERNALLY COHERENT before that action flows onward to
 * payment authorization (AP2) or checkout (ACP/UCP).
 *
 * It is a THIN WRAPPER over the published `@warp-lang/commerce-types`: every tool
 * calls a published function (`guardAction`, `validateSettlement`,
 * `planCompensation`/`validateCompensation`, `validTransitions`, `unify`) and
 * returns its verdict. No invariant or guard logic is re-implemented here. The
 * server VALIDATES and returns verdicts; it does not execute payments, run
 * checkout, settle funds, hold credentials, or make network calls.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  guardAction,
  validateSettlement,
  planCompensation,
  createSession,
  validateCompensation,
  validTransitions,
  unify,
  type World,
  type ProposedAction,
  type CommitmentState,
  type Money,
  type MoneyBreakdown,
  type ForwardStep,
  type UnifySource,
} from "@warp-lang/commerce-types";
import {
  guardActionInput,
  validateSettlementInput,
  checkCompensationInput,
  validTransitionsInput,
  unifySourcesInput,
} from "./schemas.js";

export const SERVER_NAME = "warp-commerce-integrity";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Warp's commerce-integrity guardrail as MCP tools. Use these to check that a",
  "proposed commerce action is STRUCTURALLY COHERENT — value is conserved, state",
  "moves are legal, refunds/settlements reconcile, compensations are valid —",
  "BEFORE the action flows to payment authorization or checkout. Each tool returns",
  "a structured verdict (ok, or the violation rule + message + fix + legal",
  "alternatives) for the agent to act on. These tools validate only; they do not",
  "authorize payments, execute checkout, settle funds, or hold credentials.",
].join(" ");

// A pure-validation tool: it reads its input and returns a verdict, with no side
// effects, no external world access, and no mutation of anything it is given.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Render any verdict object as the tool's structured JSON result. */
function verdict(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A clean, non-crashing error result for an input the published function could not process. */
function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
  };
}

/**
 * Build a configured Warp commerce-integrity MCP server. Connect it to any
 * transport (stdio for local hosts; an in-memory transport in tests).
 */
export function createWarpMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // guard_action — validate a single proposed action against a world.
  server.registerTool(
    "guard_action",
    {
      title: "Guard a commerce action",
      description:
        "Validate a single proposed action (move one commitment in `world` to a new state) for structural coherence before it is executed. Returns { ok: true, next } when the move is coherent, or { ok: false, violations: [{ rule, message, fix }], alternatives? } naming the invariant that blocked it (e.g. I-1 over-refund, I-2 illegal state move) with a self-correction hint and the legal moves from the current state. Validates only — it does not execute the action.",
      inputSchema: guardActionInput,
      annotations: READ_ONLY,
    },
    async ({ world, action }) => {
      try {
        return verdict(guardAction(world as unknown as World, action as unknown as ProposedAction));
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // validate_settlement — multi-component settlement reconciliation (I-1).
  server.registerTool(
    "validate_settlement",
    {
      title: "Validate a settlement reconciliation",
      description:
        "Validate that a multi-component settlement (principal / tax / fees / shipping, a `MoneyBreakdown`) reconciles against the committed total in one currency: the breakdown's own total equals the committed total AND the components sum to it (I-1, value conservation). Returns { ok: true } or { ok: false, violations: [{ rule, message, fix }] }. Reconciliation only — it does not compute tax rates or amounts; the component amounts are caller-supplied.",
      inputSchema: validateSettlementInput,
      annotations: READ_ONLY,
    },
    async ({ settlement, committedTotal }) => {
      try {
        return verdict(
          validateSettlement(settlement as unknown as MoneyBreakdown, committedTotal as unknown as Money),
        );
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // check_compensation — validate a compensating/unwinding sequence.
  server.registerTool(
    "check_compensation",
    {
      title: "Check a compensation (unwind) plan",
      description:
        "Given a `world` and the `forward` steps that were applied to it, plan the compensating (reversing) actions and validate that running them unwinds the world coherently. Returns { ok: true, next } when the unwind is valid, or { ok: false, failedAt, violations } identifying the compensation that was rejected (e.g. an over-refund) so it can be corrected. Validates the compensation; it does not execute or orchestrate any rollback.",
      inputSchema: checkCompensationInput,
      annotations: READ_ONLY,
    },
    async ({ world, forward, at }) => {
      try {
        const w = world as unknown as World;
        const plan = planCompensation(w, forward as unknown as ForwardStep[], at);
        const session = createSession(w);
        const result = validateCompensation(session, plan);
        return verdict({
          ...result,
          plan: { steps: plan.steps.length, skipped: plan.skipped },
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // valid_transitions — the planning oracle: legal moves from a state.
  server.registerTool(
    "valid_transitions",
    {
      title: "List legal transitions from a state",
      description:
        "The planning oracle: given a commitment's current state, return the legal target state types the model permits from it (read from the frozen transition table). Use this to plan a valid move instead of guessing. A listed move is a legal transition, not a guaranteed-safe action — reaching it with particular data may still be rejected by another invariant (use guard_action to check the concrete move).",
      inputSchema: validTransitionsInput,
      annotations: READ_ONLY,
    },
    async ({ from }) => {
      try {
        const fromState = from as unknown as CommitmentState;
        return verdict({ from: fromState.type, legalMoves: validTransitions(fromState) });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // unify_sources — cross-platform unification / correspondence check.
  server.registerTool(
    "unify_sources",
    {
      title: "Unify corresponded platform sources",
      description:
        "Merge caller-corresponded platform objects (e.g. a Shopify order and a Stripe charge the caller asserts are the same transaction) into one validated commitment, and confirm value is conserved across them. Returns { ok: true, commitment } when coherent, or { ok: false, violations } when the sources disagree — most importantly an I-1 value-conservation mismatch when the platforms report different amounts. The correspondence is the caller's assertion; this validates the merge, it does not infer which objects correspond.",
      inputSchema: unifySourcesInput,
      annotations: READ_ONLY,
    },
    async ({ sources }) => {
      try {
        return verdict(unify(sources as unknown as UnifySource[]));
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}
