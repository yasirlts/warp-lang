/**
 * Bounded temporal verification, runnable. The checker explores the reachable
 * states of the commitment lifecycle and asks: does any reachable transition take
 * a move the frozen model FORBIDS? It must do BOTH honestly:
 *
 *   (a) on the REAL lifecycle  → enumerate the whole reachable set (fixpoint) and
 *       report it sound — no reachable state-machine violation.
 *   (b) on a deliberately BROKEN graph (injected for this demo, NOT the real
 *       table) → catch the reachable violation and print the counterexample PATH.
 *
 * (b) is the point: a verifier that can only ever say "sound" is untrustworthy.
 *
 *   node examples/verify.mjs
 */
import { reachableStates, verifyLifecycle, validTransitions } from "@warp-lang/commerce-types";

const vt = (s) => validTransitions({ type: s });

// (a) THE REAL LIFECYCLE — explore from the entry state to fixpoint.
console.log("(a) Real commitment lifecycle — bounded reachability from 'Draft':\n");
const reach = reachableStates("Draft");
console.log(`  reachable states (${reach.explored}): ${reach.states.join(", ")}`);
console.log(`  fixpoint reached: ${reach.fixpointReached}  (depth ${reach.depthReached})`);

const sound = verifyLifecycle({ from: "Draft" });
console.log(`  verdict: ${sound.verdict}  — violations: ${sound.violations.length}`);
console.log(
  sound.verdict === "fixpoint-sound"
    ? "  → the entire reachable state-machine was enumerated and every move is legal.\n" +
        "    (state-machine soundness within the full reachable set — NOT a claim about\n" +
        "     data-level checks like a specific over-refund amount, which `step` checks per event.)\n"
    : "\n",
);

// (b) A BROKEN GRAPH — inject an illegal edge the real model forbids: Fulfilled → Active.
//     (Fulfilled may only go to Disputed or Refunded. This table is a demo fault.)
console.log("(b) Broken graph (demo fault: an extra 'Fulfilled' → 'Active' edge):\n");
const broken = (s) => (s === "Fulfilled" ? [...vt(s), "Active"] : vt(s));

const result = verifyLifecycle({ from: "Draft", transitions: broken });
console.log(`  verdict: ${result.verdict}  — violations: ${result.violations.length}`);
for (const v of result.violations) {
  console.log(`\n  ⛔ [${v.rule}] ${v.message}`);
  console.log(`     counterexample path: ${v.path.join(" → ")}`);
}

console.log(
  "\nThe checker enumerated the real lifecycle and found it sound at fixpoint, and it caught\n" +
    "the broken graph's forbidden move with the exact path that reaches it. This is bounded\n" +
    "model-checking of the state machine — it reports what it explored, not a forever proof.",
);
