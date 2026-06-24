/**
 * Zod input schemas for the Warp commerce-integrity MCP tools.
 *
 * Untrusted-input discipline (MCP security guidance): every value handed to a
 * tool comes from an LLM, not a human, so it is validated server-side before it
 * reaches Warp's guard. Two strictness tiers, by what the value IS:
 *
 *  - **Agent-authored action payloads** — what the agent is *proposing to do*
 *    (a `CommitmentState` target, a `ProposedAction`, a `ForwardStep`, a money
 *    breakdown) — are `.strict()` (additionalProperties:false). An unexpected
 *    key here is a malformed proposal and is rejected.
 *  - **Pre-existing world state** the agent merely *passes through* (the
 *    `Commitment`/`Value`/`Party`/`Fulfillment` objects it read from its system)
 *    is structurally validated — required fields are typed — but unknown keys are
 *    stripped rather than rejected. Warp's guard reads a fixed, known field set
 *    and is itself the authoritative validator; an extra field on a passed-through
 *    commitment cannot change the verdict, and enumerating the full generated
 *    commerce schema here would duplicate it and reject genuine, richer payloads.
 *
 * These schemas mirror the published `@warp-lang/commerce-types` shapes; they do
 * not re-implement any guard or invariant logic. The parsed values are handed to
 * the published functions, which do the authoritative checking.
 */
import { z } from "zod";

// --- Money ------------------------------------------------------------------

export const MoneySchema = z
  .object({
    amount: z.number(),
    currency: z.string().min(1),
  })
  .strict();

const MoneyComponentSchema = z
  .object({
    kind: z.enum(["Base", "Tax", "Discount", "Shipping", "Surcharge", "Tip", "Adjustment"]),
    amount: MoneySchema,
    label: z.string().optional(),
    tax_rate: z.number().optional(),
    jurisdiction: z.string().optional(),
  })
  .strict();

export const MoneyBreakdownSchema = z
  .object({
    total: MoneySchema,
    components: z.array(MoneyComponentSchema),
  })
  .strict();

// --- CommitmentState (closed, fully-modeled discriminated union) -------------
// Strict per variant: the agent's proposed target state must match the model
// exactly. PartyID/CommitmentID are branded strings — plain strings over the wire.

export const CommitmentStateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Draft") }).strict(),
  z.object({ type: z.literal("Proposed") }).strict(),
  z
    .object({
      type: z.literal("Tendered"),
      offer_amount: z.number(),
      offer_currency: z.string(),
      closes_at: z.string(),
      superseded_by: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal("Accepted") }).strict(),
  z
    .object({ type: z.literal("Modified"), modified_by: z.string(), reason: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("PartiallyFulfilled"),
      fulfilled_item_ids: z.array(z.string()),
      remaining_item_ids: z.array(z.string()),
    })
    .strict(),
  z.object({ type: z.literal("Active") }).strict(),
  z.object({ type: z.literal("Fulfilled") }).strict(),
  z
    .object({ type: z.literal("Cancelled"), by: z.string(), reason: z.string(), at: z.string() })
    .strict(),
  z
    .object({ type: z.literal("Disputed"), by: z.string(), reason: z.string(), opened_at: z.string() })
    .strict(),
  z.object({ type: z.literal("Refunded"), amount: MoneySchema, at: z.string() }).strict(),
]);

// --- Pass-through world state (structural; unknown keys stripped) ------------

const ValueSchema = z.object({
  id: z.string(),
  form: z.object({ kind: z.string() }).passthrough(),
  quantity: z.number(),
  state: z.object({ type: z.string() }).passthrough(),
});

const TransitionSchema = z.object({
  from: CommitmentStateSchema,
  to: CommitmentStateSchema,
  at: z.string(),
  actor: z.string(),
  reason: z.string().optional(),
});

const CommitmentSchema = z.object({
  id: z.string(),
  parties: z.object({
    initiator: z.string(),
    counterparty: z.string(),
    intermediaries: z.array(z.string()).default([]),
  }),
  subject: z.object({
    offered: z.array(ValueSchema).default([]),
    requested: z.array(ValueSchema).default([]),
  }),
  state: CommitmentStateSchema,
  history: z.array(TransitionSchema).default([]),
  parent: z.string().optional(),
  children: z.array(z.string()).default([]),
  originated_from: z.string().optional(),
  created_at: z.string().optional(),
  expires_at: z.string().optional(),
  terms: z.unknown().optional(),
});

const FulfillmentSchema = z
  .object({
    id: z.string(),
    commitment: z.string(),
    state: z.object({ type: z.string() }).passthrough(),
    history: z.array(z.unknown()).default([]),
    planned_at: z.string().optional(),
  })
  .passthrough();

const PartySchema = z
  .object({ id: z.string() })
  .passthrough();

export const WorldSchema = z
  .object({
    commitments: z.array(CommitmentSchema),
    fulfillments: z.array(FulfillmentSchema).default([]),
    parties: z.array(PartySchema).default([]),
  })
  .strict();

// --- Agent-authored action payloads (strict) --------------------------------

export const ProposedActionSchema = z
  .object({
    commitment: z.string(),
    to: CommitmentStateSchema,
    actor: z.string(),
    reason: z.string().optional(),
    idempotencyKey: z.string().optional(),
    expectedVersion: z.string().optional(),
  })
  .strict();

export const ForwardStepSchema = z
  .object({
    commitment: z.string(),
    to: CommitmentStateSchema,
    actor: z.string(),
    compensateWith: CommitmentStateSchema.optional(),
    at: z.string().optional(),
  })
  .strict();

export const UnifySourceSchema = z
  .object({
    platform: z.enum(["shopify", "stripe", "woocommerce", "paypal", "amazon"]),
    commitment: CommitmentSchema,
  })
  .strict();

// --- Tool parameter shapes (ZodRawShape for registerTool.inputSchema) --------
// Each is the raw shape (object of zod schemas) the MCP SDK turns into the
// tool's JSON-Schema. Top-level tool params are strict via the SDK.

export const guardActionInput = {
  world: WorldSchema,
  action: ProposedActionSchema,
} as const;

export const validateSettlementInput = {
  settlement: MoneyBreakdownSchema,
  committedTotal: MoneySchema,
} as const;

export const checkCompensationInput = {
  world: WorldSchema,
  forward: z.array(ForwardStepSchema).min(1),
  at: z.string(),
} as const;

export const validTransitionsInput = {
  from: CommitmentStateSchema,
} as const;

export const unifySourcesInput = {
  sources: z.array(UnifySourceSchema).min(1),
} as const;
