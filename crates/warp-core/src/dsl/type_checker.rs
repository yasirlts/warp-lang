//! Warp DSL type checker (v0.1 — second compiler layer per
//! Phase 2 session 6).
//!
//! Walks a parsed [`WarpProject`] and validates three things, in
//! order — every violation is collected, none short-circuits, so a
//! merchant who has three mistakes sees three errors at once instead
//! of one at a time:
//!
//!   1. **Node existence.** Every `NODE_TYPE` in the AST must resolve
//!      against a [`NodeSpec`] in [`BUILTIN_NODE_SPECS`]. The spec
//!      list mirrors `warp-catalog::node_registry::ALL_NODES` —
//!      drift between the two is caught by a test in the catalog.
//!   2. **Reference resolution.** Every `<instance>.<field>` reference
//!      must name an instance that was declared earlier in the project,
//!      or the special name `trigger` (which refers to the first node
//!      whose category is `"triggers"`).
//!   3. **Required inputs.** Every node's [`NodeSpec::required_inputs`]
//!      must appear as a config key on its declaration.
//!
//! Output type checking (asserting that `profile.phone` is a
//! `PhoneNumber` so a `WhatsAppSend.to` slot accepts it) is deferred
//! to v0.2 — v0.1 is structural validation that's already enough to
//! catch the AI-builder's common failure modes (made-up node names,
//! typoed instance references, missing required fields) per ADR-0004.
//!
//! ## Pipeline
//!
//! ```text
//!   .warp source
//!       └── lexer ──┐
//!                   └── parser ──┐
//!                                └── type_checker ──> TypedProject
//! ```
//!
//! [`compile`](super::compile) is the end-to-end convenience.
//! [`check_types`] runs just this stage.

use std::collections::{HashMap, HashSet};
use std::fmt;

use super::ast::{ConfigEntry, ConfigValue, WarpProject};
use crate::types::model::{validate_commitment_transition, CommitmentID, CommitmentState, PartyID};

// ===========================================================================
// NodeSpec — what the type checker knows about each shipped node.
// ===========================================================================

/// One row in the type checker's catalog. Mirrors
/// `warp-catalog::node_registry::NodeManifest` with two adaptations:
///
///   * **`dsl_name`** — the PascalCase name a workflow author writes
///     in `.warp` source (e.g. `WhatsAppSend`). The catalog manifest
///     uses snake_case canvas ids (`whatsapp_send`); the DSL form is
///     what the AST carries, so the type checker indexes on this.
///   * **`required_inputs` / `optional_inputs`** — same as on the
///     manifest. Listed here so the type checker can validate without
///     reaching across the workspace into the catalog crate.
///
/// Drift between this list and the catalog's `ALL_NODES` would mean a
/// workflow that the catalog can run wouldn't compile (or vice
/// versa); the test
/// [`builtin_node_specs_match_catalog_manifest`](crate::dsl::type_checker::tests)
/// catches that by name when run from the catalog's test suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeSpec {
    pub dsl_name: &'static str,
    pub catalog_id: &'static str,
    pub category: &'static str,
    pub node_version: &'static str,
    pub required_inputs: &'static [&'static str],
    pub optional_inputs: &'static [&'static str],
}

/// Every node the v0.1 DSL recognizes. Order matches catalog's
/// `ALL_NODES` for ease of cross-reference.
pub const BUILTIN_NODE_SPECS: &[NodeSpec] = &[
    NodeSpec {
        dsl_name: "CartAbandoned",
        catalog_id: "cart_abandoned",
        category: "triggers",
        node_version: "1.0.0",
        required_inputs: &["min_value", "after"],
        optional_inputs: &[],
    },
    NodeSpec {
        dsl_name: "OrderPlaced",
        catalog_id: "order_placed",
        category: "triggers",
        node_version: "1.0.0",
        required_inputs: &["min_value"],
        optional_inputs: &["platform"],
    },
    NodeSpec {
        dsl_name: "WhatsAppSend",
        catalog_id: "whatsapp_send",
        category: "communication",
        node_version: "1.0.0",
        required_inputs: &["to", "template"],
        optional_inputs: &["lang", "params"],
    },
    NodeSpec {
        dsl_name: "DelayFor",
        catalog_id: "delay_for",
        category: "timing",
        node_version: "1.0.0",
        required_inputs: &["duration"],
        optional_inputs: &["reason"],
    },
    NodeSpec {
        dsl_name: "ACPGetCustomerProfile",
        catalog_id: "acp_get_profile",
        category: "intelligence",
        node_version: "1.0.0",
        required_inputs: &["customer_id"],
        optional_inputs: &["mock"],
    },
    NodeSpec {
        dsl_name: "ACPEvaluateStrategy",
        catalog_id: "acp_evaluate_strategy",
        category: "intelligence",
        node_version: "1.0.0",
        required_inputs: &["customer_id"],
        optional_inputs: &["mock"],
    },
    // ----- Phase 3 session 7 — marketing automation vocabulary -----
    NodeSpec {
        dsl_name: "OccasionTrigger",
        catalog_id: "occasion_trigger",
        category: "triggers",
        node_version: "1.0.0",
        required_inputs: &["occasion", "days_before"],
        optional_inputs: &[],
    },
    NodeSpec {
        dsl_name: "CustomerSegment",
        catalog_id: "customer_segment",
        category: "intelligence",
        node_version: "1.0.0",
        required_inputs: &["customer_ids", "criteria"],
        optional_inputs: &["attributes", "label", "mock"],
    },
    NodeSpec {
        dsl_name: "CampaignFanOut",
        catalog_id: "campaign_fan_out",
        category: "marketing",
        node_version: "1.0.0",
        required_inputs: &["audience", "recipients", "template_id"],
        optional_inputs: &["params", "acp_endpoint", "mock_mode"],
    },
    NodeSpec {
        dsl_name: "DelayUntil",
        catalog_id: "delay_until",
        category: "timing",
        node_version: "1.0.0",
        required_inputs: &["target_datetime"],
        optional_inputs: &["reason"],
    },
    NodeSpec {
        dsl_name: "ABTestRoute",
        catalog_id: "ab_test_route",
        category: "marketing",
        node_version: "1.0.0",
        required_inputs: &["customer_id", "experiment_id", "variant_a_weight"],
        optional_inputs: &[],
    },
];

/// Look up a node spec by its DSL (PascalCase) name.
pub fn find_node_spec(dsl_name: &str) -> Option<&'static NodeSpec> {
    BUILTIN_NODE_SPECS.iter().find(|s| s.dsl_name == dsl_name)
}

// ===========================================================================
// TypedProject — output of a successful type-check.
// ===========================================================================

/// Output of [`check_types`]. Same shape as the parser's
/// [`WarpProject`] but with every node's catalog id, category, and
/// pinned node version attached. Downstream layers (code generator,
/// canvas builder) consume this rather than re-resolving names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedProject {
    pub name: String,
    pub version: String,
    pub tenant: String,
    pub nodes: Vec<TypedNodeDecl>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypedNodeDecl {
    pub node_type: String,
    pub instance_name: String,
    pub category: String,
    pub node_version: String,
    pub config: Vec<ConfigEntry>,
}

// ===========================================================================
// TypeError — one rejection from the type checker.
// ===========================================================================

/// One reason the project failed to type-check. Every variant carries
/// the 1-based source line — same diagnostic shape ADR-0007 holds the
/// parser to per P-2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeError {
    /// `node_type` is not present in [`BUILTIN_NODE_SPECS`].
    /// `suggestion` is the closest known DSL name (Levenshtein
    /// distance ≤ 2), or `None` if nothing is near.
    UnknownNodeType {
        node_type: String,
        line: usize,
        suggestion: Option<String>,
    },
    /// A `<instance>.<field>` reference names an instance that was
    /// never declared (or wasn't declared *before* the referring node).
    UnresolvedReference {
        reference: String,
        instance: String,
        line: usize,
    },
    /// A node declaration is missing a required config key. The check
    /// runs per-node; a node with three missing keys produces three
    /// errors.
    MissingRequiredInput {
        node_type: String,
        instance_name: String,
        missing_key: String,
        line: usize,
    },
    /// CHECK I-1 (Value Conservation) — **blocking**. A single node references
    /// more than one currency code without declaring an explicit currency
    /// conversion. Pushed by [`check_types`], so it fails compilation: mixing
    /// currencies violates Value Conservation. The sanctioned path is an
    /// explicit conversion construct (see [`declares_currency_conversion`]),
    /// which compiles.
    CurrencyMixing {
        node_type: String,
        instance_name: String,
        currencies_found: Vec<String>,
        line: usize,
    },
    /// CHECK I-1 (Value Conservation) — **warning-level, opt-in**. Same
    /// detection as [`TypeError::CurrencyMixing`] but surfaced only by the
    /// separate [`check_currency_mixing`] API for tools that want a non-blocking
    /// report. [`check_types`] uses the blocking variant by default.
    CurrencyMixingWarning {
        node_type: String,
        instance_name: String,
        currencies_found: Vec<String>,
        line: usize,
    },
    /// CHECK I-2 (State Monotonicity) — **blocking**. A node sits at an earlier
    /// stage of the commerce lifecycle (Intent → Commitment → Fulfillment) than
    /// a node already declared above it: the workflow regresses to an earlier
    /// stage. The lifecycle only moves forward (a reversal is a new forward
    /// commitment, not a backward edge). Enforced at the stage granularity the
    /// DSL node vocabulary exposes (via [`model_level`]). The finer
    /// per-commitment-state edges (Draft→…→Refunded, the dispute/refund
    /// reversals) are blocked statically *only when a node declares an explicit
    /// `state`* — see [`TypeError::CommitmentStateRegression`]. Commitment
    /// states that are not declared in the DSL remain enforced solely by
    /// `types::model::validate_commitment_transition` at the type/runtime/audit
    /// layer across every binding.
    StateMonotonicityViolation {
        prior_node: String,
        regressed_node: String,
        from_stage: String,
        to_stage: String,
        line: usize,
    },
    /// CHECK I-2 (State Monotonicity) — **blocking, per-state**. Two
    /// commitment-stage nodes each declare an explicit commitment lifecycle
    /// `state` (e.g. `state: "Fulfilled"` then `state: "Accepted"`), and the
    /// declared order implies a transition that is **not** in the model's
    /// valid-transition table. This catches regressions the coarse stage check
    /// cannot see — both nodes are at the Commitment stage, so `model_level`
    /// reads them as level-equal, yet `Fulfilled → Accepted` is a backward edge.
    /// The verdict is delegated to
    /// `types::model::validate_commitment_transition` (the audit layer's table);
    /// this variant does not re-encode that table. Fires only for states that
    /// are explicitly declared in the DSL — undeclared transitions stay
    /// audit-only.
    CommitmentStateRegression {
        prior_node: String,
        regressed_node: String,
        from_state: String,
        to_state: String,
        line: usize,
    },
    /// CHECK I-3 (Capacity Verification): a workflow reaches
    /// Commitment(Accepted) via an Accepted-producing node without a prior
    /// capacity-verification step (Invariant 3).
    MissingCapacityVerification {
        node_type: String,
        instance_name: String,
        accepted_producing_node: String,
        line: usize,
    },
    /// CHECK I-4 (Temporal Integrity): a Fulfillment-level node appears
    /// before a Commitment-level node — Commitments form before
    /// Fulfillments execute.
    TemporalOrderViolation {
        earlier_node: String,
        later_node: String,
        line: usize,
    },
    /// CHECK I-5 (Identity Permanence): two node instances share a name.
    DuplicateInstanceName {
        name: String,
        first_declared_line: usize,
        duplicate_line: usize,
    },
    /// CHECK I-6 (Commitment Tree Consistency): a child Commitment's literal
    /// value exceeds the parent Commitment's.
    CommitmentTreeInconsistency {
        parent_node: String,
        parent_value: String,
        child_node: String,
        child_value: String,
        line: usize,
    },
}

impl fmt::Display for TypeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TypeError::UnknownNodeType {
                node_type,
                line,
                suggestion,
            } => match suggestion {
                Some(s) => write!(
                    f,
                    "Line {}: Unknown node type '{}'. Did you mean '{}'?",
                    line, node_type, s
                ),
                None => write!(f, "Line {}: Unknown node type '{}'.", line, node_type),
            },
            TypeError::UnresolvedReference {
                reference,
                instance,
                line,
            } => write!(
                f,
                "Line {}: Reference '{}' points at instance '{}', which is not declared \
                 above this node. Declare it earlier or use the keyword 'trigger'.",
                line, reference, instance
            ),
            TypeError::MissingRequiredInput {
                node_type,
                instance_name,
                missing_key,
                line,
            } => write!(
                f,
                "Line {}: {} '{}' is missing required input '{}'.",
                line, node_type, instance_name, missing_key
            ),
            TypeError::CurrencyMixing {
                node_type,
                instance_name,
                currencies_found,
                line,
            } => write!(
                f,
                "Line {}: Node '{}' ({}) references multiple currencies: {}. Mixed-currency \
                 values violate Value Conservation (Invariant 1) — they cannot be combined \
                 without loss. Convert to a single currency first; an explicit currency \
                 conversion is the sanctioned path.",
                line,
                instance_name,
                node_type,
                currencies_found.join(", ")
            ),
            TypeError::CurrencyMixingWarning {
                node_type,
                instance_name,
                currencies_found,
                line,
            } => write!(
                f,
                "Warning — Line {}: Node '{}' ({}) references multiple currencies: {}. \
                 Verify that currency conversion is handled before this node. \
                 Mixed-currency operations violate the Value Conservation invariant.",
                line,
                instance_name,
                node_type,
                currencies_found.join(", ")
            ),
            TypeError::StateMonotonicityViolation {
                prior_node,
                regressed_node,
                from_stage,
                to_stage,
                line,
            } => write!(
                f,
                "Line {}: State monotonicity violation. '{}' is a {}-stage node declared after \
                 '{}' ({} stage); the commerce lifecycle (Intent → Commitment → Fulfillment) \
                 only moves forward. Per Invariant 2 (State Monotonicity), a workflow cannot \
                 regress to an earlier lifecycle stage — express a reversal as a new forward \
                 commitment, not a backward step.",
                line, regressed_node, to_stage, prior_node, from_stage
            ),
            TypeError::CommitmentStateRegression {
                prior_node,
                regressed_node,
                from_state,
                to_state,
                line,
            } => write!(
                f,
                "Line {}: State monotonicity violation (per-state). '{}' declares commitment \
                 state '{}' after '{}' declared '{}', but '{}' -> '{}' is not a valid commitment \
                 transition. Per Invariant 2 (State Monotonicity), a commitment cannot regress to \
                 an earlier state — express a reversal (refund, dispute, cancellation) as a \
                 forward transition the model allows, not a backward step.",
                line, regressed_node, to_state, prior_node, from_state, from_state, to_state
            ),
            TypeError::MissingCapacityVerification {
                accepted_producing_node,
                line,
                ..
            } => write!(
                f,
                "Line {}: Workflow reaches Commitment(Accepted) via '{}' without a prior \
                 capacity verification step. Add ACPGetCustomerProfile before '{}' to verify \
                 Party capacity per Invariant 3 of the Warp Commerce Model.",
                line, accepted_producing_node, accepted_producing_node
            ),
            TypeError::TemporalOrderViolation {
                earlier_node,
                later_node,
                line,
            } => write!(
                f,
                "Line {}: Temporal order violation. '{}' produces a Fulfillment state but \
                 appears before '{}' which produces a Commitment state. In the Warp Commerce \
                 Model, Commitments form before Fulfillments execute. Move '{}' before '{}' \
                 in your workflow declaration.",
                line, earlier_node, later_node, later_node, earlier_node
            ),
            TypeError::DuplicateInstanceName {
                name,
                first_declared_line,
                duplicate_line,
            } => write!(
                f,
                "Line {}: Duplicate instance name '{}'. Already declared at line {}. Each node \
                 instance must have a unique name within a workflow. Warp uses instance names as \
                 stable identifiers — duplicates violate Identity Permanence (Invariant 5).",
                duplicate_line, name, first_declared_line
            ),
            TypeError::CommitmentTreeInconsistency {
                parent_node,
                parent_value,
                child_node,
                child_value,
                line,
            } => write!(
                f,
                "Line {}: Commitment tree inconsistency. Child commitment '{}' has value {} \
                 which exceeds parent commitment '{}' value {}. Per Invariant 6, child \
                 Commitment values must not exceed their parent.",
                line, child_node, child_value, parent_node, parent_value
            ),
        }
    }
}

impl std::error::Error for TypeError {}

// ===========================================================================
// Public entry points.
// ===========================================================================

/// One OrderPlaced node collected during type-checking for the I-6
/// commitment-tree check: `(instance_name, line, first Currency literal)`.
/// The currency is `None` when the node's value is a reference (which I-6
/// cannot compare statically).
type OrderPlacedRecord = (String, usize, Option<(u64, String)>);

/// Type-check a parsed project against [`BUILTIN_NODE_SPECS`].
/// Collects every violation — does not short-circuit on the first.
///
/// On success returns a [`TypedProject`] enriched with each node's
/// catalog id + category + pinned version. On failure returns the
/// full set of [`TypeError`]s.
pub fn check_types(project: WarpProject) -> Result<TypedProject, Vec<TypeError>> {
    let mut errors: Vec<TypeError> = Vec::new();
    let mut typed_nodes: Vec<TypedNodeDecl> = Vec::with_capacity(project.nodes.len());
    let mut declared_instances: HashSet<String> = HashSet::new();
    let mut trigger_instance: Option<String> = None;

    // CHECK I-3 (Capacity Verification) state: whether a capacity-verifying
    // node has appeared earlier in declaration order. Set when an
    // ACPGetCustomerProfile is seen; read when an Accepted-producing node
    // (OrderPlaced) is reached.
    let mut capacity_verified_seen = false;

    // CHECK I-5 (Identity Permanence): first-seen line per instance name.
    let mut instance_lines: HashMap<String, usize> = HashMap::new();
    // CHECK I-4 (Temporal Integrity): (instance_name, line, model level) for
    // nodes on the Intent(1) → Commitment(2) → Fulfillment(3) chain.
    let mut leveled_nodes: Vec<(String, usize, u8)> = Vec::new();
    // CHECK I-6 (Commitment Tree Consistency): OrderPlaced nodes with their
    // first Currency literal, if any (None when the value is a reference).
    let mut order_placed_nodes: Vec<OrderPlacedRecord> = Vec::new();
    // CHECK I-2 (State Monotonicity), per-state layer: nodes that declare an
    // explicit commitment lifecycle `state`, in declaration order. Each entry
    // is (instance_name, line, declared CommitmentState). The post-loop check
    // walks consecutive pairs and defers the verdict to the audit layer's
    // `validate_commitment_transition`.
    let mut commitment_state_nodes: Vec<(String, usize, CommitmentState)> = Vec::new();

    // CHECK I-2 (State Monotonicity) runs post-loop in two layers. The
    // STAGE layer walks `leveled_nodes`: the workflow's lifecycle stages
    // (Intent → Commitment → Fulfillment) must not regress — the granularity
    // the DSL node vocabulary exposes by default. The PER-STATE layer walks
    // `commitment_state_nodes`: when nodes declare explicit commitment states,
    // each consecutive pair is checked against the audit layer's
    // `validate_commitment_transition`, catching finer regressions
    // (Fulfilled→Accepted, Cancelled→Accepted, …) the stage layer cannot see.
    // Per-state edges that are NOT declared in the DSL stay enforced solely by
    // `validate_commitment_transition` at the type/runtime/audit layer across
    // every binding — the compiler refines *when* that table runs, never its
    // content.

    // Lines are reconstructed from a synthetic walk: the parser
    // discards the per-NodeDecl line because it captures only enough
    // for ParseError. To keep the error stream usable for v0.1, every
    // error uses the node's declared position in the project (1-based
    // index from the source order) as a stand-in. A future parser pass
    // can carry real source lines through the AST; doing so today
    // would be a parser refactor whose risk doesn't fit this session.
    let mut line: usize = 1;

    for node in project.nodes.into_iter() {
        line += 1;

        // CHECK I-5 (Identity Permanence) — instance names are unique.
        // Runs before node-type resolution so it catches duplicates even on
        // unknown node types.
        match instance_lines.get(&node.instance_name) {
            Some(&first_line) => errors.push(TypeError::DuplicateInstanceName {
                name: node.instance_name.clone(),
                first_declared_line: first_line,
                duplicate_line: line,
            }),
            None => {
                instance_lines.insert(node.instance_name.clone(), line);
            }
        }

        let spec = find_node_spec(&node.node_type);

        // CHECK 1 — node type resolves.
        let resolved_spec = match spec {
            Some(s) => s,
            None => {
                let suggestion = nearest_known_node_name(&node.node_type);
                errors.push(TypeError::UnknownNodeType {
                    node_type: node.node_type.clone(),
                    line,
                    suggestion,
                });
                // Still record this instance so a downstream node that
                // references it doesn't compound the "unknown" error
                // with a false "unresolved reference" one.
                declared_instances.insert(node.instance_name.clone());
                continue;
            }
        };

        // The first declared trigger gets the special name `trigger`.
        if trigger_instance.is_none() && resolved_spec.category == "triggers" {
            trigger_instance = Some(node.instance_name.clone());
        }

        // CHECK 2 — every Reference in the node's config resolves.
        for entry in &node.config {
            collect_reference_errors(
                entry,
                &declared_instances,
                trigger_instance.as_deref(),
                line,
                &mut errors,
            );
        }

        // CHECK 3 — required inputs are present.
        let provided_keys: HashSet<&str> = node.config.iter().map(|e| e.key.as_str()).collect();
        for required in resolved_spec.required_inputs {
            if !provided_keys.contains(required) {
                errors.push(TypeError::MissingRequiredInput {
                    node_type: node.node_type.clone(),
                    instance_name: node.instance_name.clone(),
                    missing_key: (*required).to_string(),
                    line,
                });
            }
        }

        // CHECK 4 (I-3) — a node that produces Commitment(Accepted) must be
        // preceded by a capacity-verification node (Invariant 3). Checked
        // before recording this node's own capacity contribution, so a node
        // cannot satisfy the requirement for itself.
        if produces_accepted_commitment(&node.node_type) && !capacity_verified_seen {
            errors.push(TypeError::MissingCapacityVerification {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                accepted_producing_node: node.node_type.clone(),
                line,
            });
        }
        if verifies_party_capacity(&node.node_type) {
            capacity_verified_seen = true;
        }

        // CHECK I-1 (Value Conservation) — BLOCKING. A node referencing more
        // than one distinct currency mixes currencies, which cannot be combined
        // without loss. The sanctioned path is an explicit conversion construct
        // (a `convert` / `conversion` / `currency_conversion` entry, or a
        // `from`+`to` object): a conversion legitimately names two currencies,
        // so a node that declares one is exempt.
        let mut codes: Vec<String> = Vec::new();
        for entry in &node.config {
            collect_currency_codes(&entry.value, &mut codes);
        }
        codes.sort();
        codes.dedup();
        if codes.len() > 1 && !declares_currency_conversion(&node.config) {
            errors.push(TypeError::CurrencyMixing {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                currencies_found: codes,
                line,
            });
        }

        // Collect for the post-loop I-4 (temporal order) and I-6 (commitment
        // tree) checks, which need the whole node list.
        if let Some(level) = model_level(&node.node_type) {
            leveled_nodes.push((node.instance_name.clone(), line, level));
        }
        if node.node_type == "OrderPlaced" {
            order_placed_nodes.push((
                node.instance_name.clone(),
                line,
                first_currency(&node.config),
            ));
        }

        // CHECK I-2 (per-state) collection: a node may declare an explicit
        // commitment lifecycle state via a `state: "<Name>"` config entry. When
        // it names a known CommitmentState, record it for the post-loop
        // consecutive-transition check. Unknown / absent state names contribute
        // nothing here (they stay enforced at the audit layer only).
        if let Some(state) = declared_commitment_state(&node.config) {
            commitment_state_nodes.push((node.instance_name.clone(), line, state));
        }

        declared_instances.insert(node.instance_name.clone());

        typed_nodes.push(TypedNodeDecl {
            node_type: node.node_type,
            instance_name: node.instance_name,
            category: resolved_spec.category.to_string(),
            node_version: resolved_spec.node_version.to_string(),
            config: node.config,
        });
    }

    // CHECK I-4 (Temporal Integrity) — a Fulfillment-level node (3) must not
    // appear before the first Commitment-level node (2). Commitments form
    // before Fulfillments execute.
    if let Some(commit_pos) = leveled_nodes.iter().position(|(_, _, lvl)| *lvl == 2) {
        let (commit_name, commit_line, _) = &leveled_nodes[commit_pos];
        if let Some((earlier_name, _, _)) = leveled_nodes[..commit_pos]
            .iter()
            .find(|(_, _, lvl)| *lvl == 3)
        {
            errors.push(TypeError::TemporalOrderViolation {
                earlier_node: earlier_name.clone(),
                later_node: commit_name.clone(),
                line: *commit_line,
            });
        }
    }

    // CHECK I-2 (State Monotonicity) — the lifecycle stage of declared nodes
    // (Intent=1 → Commitment=2 → Fulfillment=3, per `model_level`) must not
    // regress. A node whose stage is below the highest stage already reached is
    // a backward transition: the commerce lifecycle only moves forward (a
    // reversal is a new forward commitment, not a backward edge). This is the
    // single source for the stage ordering (`model_level`), not a second copy
    // of the commitment transition table.
    {
        let mut max_level: u8 = 0;
        let mut max_node: Option<&str> = None;
        for (name, node_line, level) in &leveled_nodes {
            if *level < max_level {
                errors.push(TypeError::StateMonotonicityViolation {
                    prior_node: max_node.unwrap_or("").to_string(),
                    regressed_node: name.clone(),
                    from_stage: stage_name(max_level).to_string(),
                    to_stage: stage_name(*level).to_string(),
                    line: *node_line,
                });
            } else {
                max_level = *level;
                max_node = Some(name);
            }
        }
    }

    // CHECK I-2 (State Monotonicity) — PER-STATE layer. The stage check above
    // only sees Intent/Commitment/Fulfillment granularity, so two nodes that
    // both sit at the Commitment stage but declare regressing commitment states
    // (e.g. `Fulfilled` then `Accepted`) slip past it. Here we walk the nodes
    // that declared an explicit `state` in declaration order and ask the audit
    // layer's `validate_commitment_transition` whether each consecutive pair is
    // a valid forward transition. An invalid pair is a backward (or otherwise
    // disallowed) edge and is blocked. The verdict is the audit table's, not a
    // second copy of it — this only refines *when* that table runs (statically,
    // at compile time, for declared states) without changing its content.
    for pair in commitment_state_nodes.windows(2) {
        let (prior_name, _, from_state) = &pair[0];
        let (regressed_name, regressed_line, to_state) = &pair[1];
        if validate_commitment_transition(from_state, to_state).is_err() {
            errors.push(TypeError::CommitmentStateRegression {
                prior_node: prior_name.clone(),
                regressed_node: regressed_name.clone(),
                from_state: commitment_state_label(from_state).to_string(),
                to_state: commitment_state_label(to_state).to_string(),
                line: *regressed_line,
            });
        }
    }

    // CHECK I-6 (Commitment Tree Consistency) — when a workflow has multiple
    // OrderPlaced (child) commitments with literal values, no child may
    // exceed the parent (the first OrderPlaced). Best-effort: only literals,
    // never references.
    if order_placed_nodes.len() > 1 {
        if let (parent_name, _parent_line, Some((parent_amount, parent_code))) = (
            &order_placed_nodes[0].0,
            order_placed_nodes[0].1,
            &order_placed_nodes[0].2,
        ) {
            for (child_name, child_line, child_value) in &order_placed_nodes[1..] {
                if let Some((child_amount, child_code)) = child_value {
                    if child_amount > parent_amount {
                        errors.push(TypeError::CommitmentTreeInconsistency {
                            parent_node: parent_name.clone(),
                            parent_value: format!("{} {}", parent_amount, parent_code),
                            child_node: child_name.clone(),
                            child_value: format!("{} {}", child_amount, child_code),
                            line: *child_line,
                        });
                    }
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(TypedProject {
            name: project.name,
            version: project.version,
            tenant: project.tenant,
            nodes: typed_nodes,
        })
    } else {
        Err(errors)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Walk a [`ConfigEntry`] and append a [`TypeError::UnresolvedReference`]
/// for every `<instance>.<field>` whose instance isn't declared above.
/// Nested objects recurse.
fn collect_reference_errors(
    entry: &ConfigEntry,
    declared: &HashSet<String>,
    trigger_alias: Option<&str>,
    line: usize,
    out: &mut Vec<TypeError>,
) {
    match &entry.value {
        ConfigValue::Reference { instance, field } => {
            if instance == "trigger" {
                if trigger_alias.is_none() {
                    out.push(TypeError::UnresolvedReference {
                        reference: format!("{}.{}", instance, field),
                        instance: instance.clone(),
                        line,
                    });
                }
                return;
            }
            if !declared.contains(instance) {
                out.push(TypeError::UnresolvedReference {
                    reference: format!("{}.{}", instance, field),
                    instance: instance.clone(),
                    line,
                });
            }
        }
        ConfigValue::Object(entries) => {
            for nested in entries {
                collect_reference_errors(nested, declared, trigger_alias, line, out);
            }
        }
        ConfigValue::StringLit(_) | ConfigValue::Currency { .. } | ConfigValue::Duration { .. } => {
        }
    }
}

/// Suggest the closest known DSL node name within Levenshtein distance
/// 2, or `None` if nothing fits. Cheap edit-distance — we have six
/// names and no hot path here.
fn nearest_known_node_name(unknown: &str) -> Option<String> {
    let unknown_lower = unknown.to_ascii_lowercase();
    let mut best: Option<(usize, &'static str)> = None;
    for spec in BUILTIN_NODE_SPECS {
        let d = levenshtein(&unknown_lower, &spec.dsl_name.to_ascii_lowercase());
        if d <= 2 {
            match best {
                None => best = Some((d, spec.dsl_name)),
                Some((b, _)) if d < b => best = Some((d, spec.dsl_name)),
                _ => {}
            }
        }
    }
    best.map(|(_, name)| name.to_string())
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let m = a.len();
    let n = b.len();
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

// ---------------------------------------------------------------------------
// Invariant-check helpers (I-1, I-3)
// ---------------------------------------------------------------------------

/// Does this DSL node produce a Commitment in `Accepted` state? At P2 the
/// only such node is `OrderPlaced` (model: `Order(paid) → Commitment(Accepted)`).
/// A future node registry annotation will replace this hardcoded set.
fn produces_accepted_commitment(dsl_name: &str) -> bool {
    matches!(dsl_name, "OrderPlaced")
}

/// Does this DSL node verify a Party's capacity (Invariant 3 substrate)? At
/// P2 `ACPGetCustomerProfile` retrieves the Party profile that carries
/// capacity information.
fn verifies_party_capacity(dsl_name: &str) -> bool {
    matches!(dsl_name, "ACPGetCustomerProfile")
}

/// A DSL node's position on the model's temporal chain (I-4):
/// Intent (1) → Commitment (2) → Fulfillment (3). `None` for nodes that
/// are not state changes on that chain (Party reads, strategy, marketing,
/// routing). Mirrors the catalog's `ModelTransition` annotation, which the
/// compiler cannot import (warp-core does not depend on warp-catalog).
fn model_level(dsl_name: &str) -> Option<u8> {
    match dsl_name {
        "CartAbandoned" | "OccasionTrigger" => Some(1), // Intent
        "OrderPlaced" => Some(2),                       // Commitment
        "WhatsAppSend" | "DelayFor" | "DelayUntil" => Some(3), // Fulfillment
        _ => None,
    }
}

/// The first `Currency(amount, code)` literal in a node's config, for the
/// I-6 best-effort tree check. `None` when the node has no literal currency
/// (e.g. its value is a reference, which cannot be compared statically).
fn first_currency(config: &[ConfigEntry]) -> Option<(u64, String)> {
    config.iter().find_map(|e| match &e.value {
        ConfigValue::Currency { amount, code } => Some((*amount, code.clone())),
        _ => None,
    })
}

/// CHECK I-1 (Value Conservation, warning-level). Returns a
/// [`TypeError::CurrencyMixingWarning`] for every node whose config
/// references more than one distinct currency code. This is a **warning**:
/// it is returned separately and never fails compilation. The full check
/// requires dataflow analysis (which reference flows into which input);
/// at P2 we flag the simpler intra-node case so a likely-missing conversion
/// is surfaced.
pub fn check_currency_mixing(project: &WarpProject) -> Vec<TypeError> {
    let mut out = Vec::new();
    for (idx, node) in project.nodes.iter().enumerate() {
        // Mirror check_types' synthetic line numbering: first node is line 2
        // (a 1-based source-order stand-in until the parser carries real lines).
        let line = idx + 2;
        let mut codes: Vec<String> = Vec::new();
        for entry in &node.config {
            collect_currency_codes(&entry.value, &mut codes);
        }
        codes.sort();
        codes.dedup();
        if codes.len() > 1 {
            out.push(TypeError::CurrencyMixingWarning {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                currencies_found: codes,
                line,
            });
        }
    }
    out
}

/// The lifecycle stage name for a `model_level` (I-2 diagnostics).
fn stage_name(level: u8) -> &'static str {
    match level {
        1 => "Intent",
        2 => "Commitment",
        3 => "Fulfillment",
        _ => "unknown",
    }
}

/// The commitment lifecycle state a node declares via a top-level
/// `state: "<Name>"` config entry, if it names a known [`CommitmentState`].
/// Returns `None` when no such entry exists or the name is not recognized —
/// in both cases the per-state I-2 check simply skips the node (the audit
/// layer still governs the full transition table at runtime).
fn declared_commitment_state(config: &[ConfigEntry]) -> Option<CommitmentState> {
    config.iter().find_map(|e| {
        if e.key.eq_ignore_ascii_case("state") {
            if let ConfigValue::StringLit(name) = &e.value {
                return commitment_state_from_name(name);
            }
        }
        None
    })
}

/// Map a declared state *name* to a representative [`CommitmentState`] value so
/// it can be fed to the audit layer's [`validate_commitment_transition`]. The
/// transition table matches on the variant alone (its `{ .. }` patterns ignore
/// payloads), so the placeholder payloads here never affect the verdict — they
/// exist only because the enum's data-bearing variants require *some* value to
/// construct. This is deliberately a name→variant adapter, not a transition
/// table; the validity rules live entirely in `validate_commitment_transition`.
fn commitment_state_from_name(name: &str) -> Option<CommitmentState> {
    // Placeholders for data-bearing variants. Constructed from non-empty
    // strings so the ID/Party constructors accept them; the values are never
    // inspected by the transition table.
    let party = PartyID::new("placeholder").ok()?;
    match name.trim() {
        "Draft" => Some(CommitmentState::Draft),
        "Proposed" => Some(CommitmentState::Proposed),
        "Tendered" => Some(CommitmentState::Tendered {
            offer_amount: "0".to_string(),
            offer_currency: "MAD".to_string(),
            closes_at: String::new(),
            superseded_by: None::<CommitmentID>,
        }),
        "Accepted" => Some(CommitmentState::Accepted),
        "Modified" => Some(CommitmentState::Modified {
            modified_by: party,
            reason: String::new(),
        }),
        "PartiallyFulfilled" => Some(CommitmentState::PartiallyFulfilled {
            fulfilled_item_ids: Vec::new(),
            remaining_item_ids: Vec::new(),
        }),
        "Active" => Some(CommitmentState::Active),
        "Fulfilled" => Some(CommitmentState::Fulfilled),
        "Cancelled" => Some(CommitmentState::Cancelled {
            by: party,
            reason: String::new(),
            at: String::new(),
        }),
        "Disputed" => Some(CommitmentState::Disputed {
            by: party,
            reason: String::new(),
            opened_at: String::new(),
        }),
        "Refunded" => Some(CommitmentState::Refunded {
            amount_str: "0".to_string(),
            currency: "MAD".to_string(),
            at: String::new(),
        }),
        _ => None,
    }
}

/// The display name of a [`CommitmentState`] for per-state I-2 diagnostics.
fn commitment_state_label(state: &CommitmentState) -> &'static str {
    match state {
        CommitmentState::Draft => "Draft",
        CommitmentState::Proposed => "Proposed",
        CommitmentState::Tendered { .. } => "Tendered",
        CommitmentState::Accepted => "Accepted",
        CommitmentState::Modified { .. } => "Modified",
        CommitmentState::PartiallyFulfilled { .. } => "PartiallyFulfilled",
        CommitmentState::Active => "Active",
        CommitmentState::Fulfilled => "Fulfilled",
        CommitmentState::Cancelled { .. } => "Cancelled",
        CommitmentState::Disputed { .. } => "Disputed",
        CommitmentState::Refunded { .. } => "Refunded",
    }
}

/// Does this node declare an explicit currency conversion — the sanctioned way
/// to legitimately reference two currencies (I-1)? True when a config entry's
/// key is `convert` / `conversion` / `currency_conversion` (case-insensitive),
/// or when a nested object pairs a `from`/`from_currency` with a
/// `to`/`to_currency` key (the model's `CurrencyConversion { from, to, … }`
/// shape). A conversion node is exempt from the currency-mixing error; an
/// un-converted mix is rejected.
fn declares_currency_conversion(config: &[ConfigEntry]) -> bool {
    config.iter().any(entry_is_conversion)
}

fn entry_is_conversion(entry: &ConfigEntry) -> bool {
    let key = entry.key.to_ascii_lowercase();
    if matches!(
        key.as_str(),
        "convert" | "conversion" | "currency_conversion"
    ) {
        return true;
    }
    if let ConfigValue::Object(entries) = &entry.value {
        let keys: HashSet<String> = entries.iter().map(|e| e.key.to_ascii_lowercase()).collect();
        let has_from = keys.contains("from") || keys.contains("from_currency");
        let has_to = keys.contains("to") || keys.contains("to_currency");
        if has_from && has_to {
            return true;
        }
        // Recurse: a conversion construct may be nested deeper.
        if entries.iter().any(entry_is_conversion) {
            return true;
        }
    }
    false
}

/// Collect every currency code appearing in a config value, recursing into
/// nested objects.
fn collect_currency_codes(value: &ConfigValue, out: &mut Vec<String>) {
    match value {
        ConfigValue::Currency { code, .. } => out.push(code.clone()),
        ConfigValue::Object(entries) => {
            for entry in entries {
                collect_currency_codes(&entry.value, out);
            }
        }
        ConfigValue::StringLit(_)
        | ConfigValue::Duration { .. }
        | ConfigValue::Reference { .. } => {}
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::lexer::lex;
    use crate::dsl::parser::parse;

    fn parse_str(src: &str) -> WarpProject {
        let tokens = lex(src).expect("lex must succeed");
        parse(tokens).expect("parse must succeed")
    }

    const FULL_CART_RECOVERY: &str = r#"
        project "cart_recovery" {
            version = "1.0.0"
            tenant  = "tenant_aimer_prod_001"

            CartAbandoned trigger {
                min_value: Currency(200, MAD)
                after:     Duration(30, minutes)
            }

            ACPGetCustomerProfile profile {
                customer_id: trigger.customer_id
            }

            WhatsAppSend first_touch {
                to:       profile.phone
                template: "cart_reminder"
                lang:     profile.language
            }

            DelayFor wait {
                duration: Duration(24, hours)
            }

            ACPEvaluateStrategy offer {
                customer_id: trigger.customer_id
            }

            WhatsAppSend followup {
                to:       profile.phone
                template: "cart_offer"
                lang:     profile.language
                params:   { discount_code: offer.discount_code }
            }
        }
    "#;

    #[test]
    fn type_checker_accepts_valid_cart_recovery_project() {
        let project = parse_str(FULL_CART_RECOVERY);
        let typed = check_types(project).expect("full cart recovery must type-check");
        assert_eq!(typed.name, "cart_recovery");
        assert_eq!(typed.nodes.len(), 6);
        // Catalog metadata propagated.
        assert_eq!(typed.nodes[0].category, "triggers");
        assert_eq!(typed.nodes[0].node_version, "1.0.0");
        assert_eq!(typed.nodes[2].node_type, "WhatsAppSend");
        assert_eq!(typed.nodes[2].category, "communication");
    }

    #[test]
    fn type_checker_rejects_unknown_node_type() {
        // `WhatsappSend` (lowercase p) — typo, should resolve to a
        // suggestion of `WhatsAppSend`.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }

                WhatsappSend bad {
                    to:       "+212661234567"
                    template: "cart_reminder"
                }
            }
        "#;
        let project = parse_str(src);
        let errors = check_types(project).expect_err("unknown node type must fail");
        assert!(
            errors.iter().any(|e| matches!(
                e,
                TypeError::UnknownNodeType { node_type, suggestion: Some(s), .. }
                    if node_type == "WhatsappSend" && s == "WhatsAppSend"
            )),
            "got {:?}",
            errors
        );
    }

    #[test]
    fn type_checker_rejects_unresolved_reference() {
        // `customer.phone` — `customer` was never declared.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }

                WhatsAppSend send {
                    to:       customer.phone
                    template: "cart_reminder"
                }
            }
        "#;
        let project = parse_str(src);
        let errors = check_types(project).expect_err("undeclared reference must fail");
        assert!(
            errors.iter().any(|e| matches!(
                e,
                TypeError::UnresolvedReference { instance, .. } if instance == "customer"
            )),
            "got {:?}",
            errors
        );
    }

    #[test]
    fn type_checker_rejects_missing_required_input() {
        // WhatsAppSend missing `to`.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }

                WhatsAppSend send {
                    template: "cart_reminder"
                }
            }
        "#;
        let project = parse_str(src);
        let errors = check_types(project).expect_err("missing required input must fail");
        assert!(
            errors.iter().any(|e| matches!(
                e,
                TypeError::MissingRequiredInput { missing_key, node_type, .. }
                    if missing_key == "to" && node_type == "WhatsAppSend"
            )),
            "got {:?}",
            errors
        );
    }

    #[test]
    fn type_checker_collects_all_errors_not_just_first() {
        // Three independent problems on one project:
        //   * Bogus node type `Whatever`
        //   * Reference to undeclared `ghost.field`
        //   * WhatsAppSend missing `to`
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }

                Whatever bogus { }

                WhatsAppSend send {
                    template: ghost.field
                }
            }
        "#;
        let project = parse_str(src);
        let errors = check_types(project).expect_err("three issues must surface as three errors");
        let unknown = errors
            .iter()
            .filter(|e| matches!(e, TypeError::UnknownNodeType { .. }))
            .count();
        let unresolved = errors
            .iter()
            .filter(|e| matches!(e, TypeError::UnresolvedReference { .. }))
            .count();
        let missing = errors
            .iter()
            .filter(|e| matches!(e, TypeError::MissingRequiredInput { .. }))
            .count();
        assert!(unknown >= 1, "expected at least one UnknownNodeType");
        assert!(unresolved >= 1, "expected at least one UnresolvedReference");
        assert!(missing >= 1, "expected at least one MissingRequiredInput");
        assert!(
            errors.len() >= 3,
            "must not short-circuit on first error; got {} errors: {:?}",
            errors.len(),
            errors
        );
    }

    #[test]
    fn type_checker_error_messages_are_human_readable() {
        // Every TypeError must render to a non-empty, line-numbered
        // string. The unknown-node-type variant must include the
        // `Did you mean` suggestion when one exists.
        let errors = vec![
            TypeError::UnknownNodeType {
                node_type: "WhatsappSend".to_string(),
                line: 12,
                suggestion: Some("WhatsAppSend".to_string()),
            },
            TypeError::UnresolvedReference {
                reference: "ghost.field".to_string(),
                instance: "ghost".to_string(),
                line: 4,
            },
            TypeError::MissingRequiredInput {
                node_type: "WhatsAppSend".to_string(),
                instance_name: "send".to_string(),
                missing_key: "to".to_string(),
                line: 9,
            },
        ];
        for e in errors {
            let msg = e.to_string();
            assert!(!msg.is_empty(), "diagnostic must not be empty");
            assert!(
                msg.contains("Line "),
                "diagnostic must name the line: got {:?}",
                msg
            );
        }
        let with_suggestion = TypeError::UnknownNodeType {
            node_type: "WhatsappSend".to_string(),
            line: 12,
            suggestion: Some("WhatsAppSend".to_string()),
        };
        let msg = with_suggestion.to_string();
        assert!(msg.contains("Did you mean"), "got {:?}", msg);
        assert!(msg.contains("WhatsAppSend"), "got {:?}", msg);
    }

    #[test]
    fn type_checker_trigger_keyword_resolves_to_first_trigger() {
        // The reference `trigger.foo` is legal in any node declared
        // after the first triggers-category node; it points at the
        // implicit handle of that trigger's outputs.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned my_trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }

                ACPGetCustomerProfile profile {
                    customer_id: trigger.customer_id
                }
            }
        "#;
        let project = parse_str(src);
        let typed = check_types(project).expect("trigger keyword must resolve");
        assert_eq!(typed.nodes.len(), 2);
    }

    // ========================================================================
    // P2 compiler invariant checks — I-1, I-2, I-3.
    // ========================================================================

    #[test]
    fn check_i1_warns_on_mixed_currencies_in_same_node() {
        // A node referencing both MAD and EUR — likely a missing conversion.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                    cap:       Currency(50, EUR)
                }
            }
        "#;
        let project = parse_str(src);
        let warnings = check_currency_mixing(&project);
        assert_eq!(warnings.len(), 1, "got {warnings:?}");
        match &warnings[0] {
            TypeError::CurrencyMixingWarning {
                currencies_found, ..
            } => {
                assert!(currencies_found.contains(&"MAD".to_string()));
                assert!(currencies_found.contains(&"EUR".to_string()));
            }
            other => panic!("expected CurrencyMixingWarning, got {other:?}"),
        }
        // It must render as a warning, not crash.
        assert!(warnings[0].to_string().contains("Warning"));
    }

    #[test]
    fn check_i1_passes_on_single_currency() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }
            }
        "#;
        let project = parse_str(src);
        assert!(check_currency_mixing(&project).is_empty());
    }

    #[test]
    fn check_i1_blocks_mixed_currencies_in_check_types() {
        // BLOCKING by default: a node referencing MAD and EUR fails to compile,
        // citing Invariant 1 — no explicit conversion is declared.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                    cap:       Currency(50, EUR)
                }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("mixed currencies must block");
        let mixing = errors
            .iter()
            .find(|e| matches!(e, TypeError::CurrencyMixing { .. }))
            .expect("a blocking CurrencyMixing error");
        let msg = mixing.to_string();
        assert!(msg.contains("Invariant 1"), "got {msg}");
        assert!(
            !msg.contains("Warning"),
            "blocking error must not be a warning: {msg}"
        );
        match mixing {
            TypeError::CurrencyMixing {
                currencies_found, ..
            } => {
                assert!(currencies_found.contains(&"MAD".to_string()));
                assert!(currencies_found.contains(&"EUR".to_string()));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn check_i1_conversion_construct_compiles() {
        // The sanctioned escape: a node that declares an explicit conversion
        // legitimately names two currencies and must COMPILE (rigor, not
        // rigidity). Single trigger node, no other invariant in play.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                    convert:   { from: Currency(50, EUR), to: Currency(550, MAD) }
                }
            }
        "#;
        let result = check_types(parse_str(src));
        if let Err(errors) = &result {
            assert!(
                !errors
                    .iter()
                    .any(|e| matches!(e, TypeError::CurrencyMixing { .. })),
                "conversion construct must be exempt from I-1; got {errors:?}"
            );
        }
    }

    #[test]
    fn check_i1_single_currency_compiles_through_check_types() {
        // A single-currency workflow has no mixing and compiles.
        assert!(check_types(parse_str(
            r#"project "x" { version="1.0.0" tenant="t"
               CartAbandoned trigger { min_value: Currency(200, MAD) after: Duration(30, minutes) } }"#
        ))
        .is_ok());
    }

    #[test]
    fn check_i2_rejects_backward_stage_transition() {
        // OrderPlaced (Commitment stage) followed by OccasionTrigger (Intent
        // stage) regresses the lifecycle Commitment -> Intent. ACP first keeps
        // I-3 satisfied, isolating the I-2 failure.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced ord { min_value: Currency(200, MAD) }
                OccasionTrigger occ { occasion: "eid" days_before: "7" }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("backward stage must fail");
        let mono = errors
            .iter()
            .find(|e| matches!(e, TypeError::StateMonotonicityViolation { .. }))
            .expect("a StateMonotonicityViolation");
        let msg = mono.to_string();
        assert!(msg.contains("Invariant 2"), "got {msg}");
        match mono {
            TypeError::StateMonotonicityViolation {
                from_stage,
                to_stage,
                ..
            } => {
                assert_eq!(from_stage, "Commitment");
                assert_eq!(to_stage, "Intent");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn check_i2_forward_lifecycle_compiles() {
        // A monotone Intent -> Commitment -> Fulfillment workflow compiles; the
        // sanctioned forward progression is not rejected. ACP precedes
        // OrderPlaced for I-3.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                CartAbandoned trigger { min_value: Currency(200, MAD) after: Duration(30, minutes) }
                ACPGetCustomerProfile profile { customer_id: trigger.customer_id }
                OrderPlaced ord { min_value: Currency(200, MAD) }
                WhatsAppSend msg { to: "+212661234567" template: "t" }
            }
        "#;
        assert!(
            check_types(parse_str(src)).is_ok(),
            "monotone lifecycle must compile"
        );
    }

    #[test]
    fn check_i2_same_stage_repeats_compile() {
        // Two Fulfillment-stage nodes in a row are NOT a regression (same stage).
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" }
                DelayFor b { duration: Duration(1, hours) }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn check_i2_per_state_blocks_fulfilled_to_accepted() {
        // PER-STATE refinement: two nodes both at the Fulfillment *stage* (so the
        // coarse stage check sees no regression), but they declare commitment
        // states Fulfilled then Accepted. `Fulfilled -> Accepted` is not in the
        // audit-layer transition table, so the per-state check blocks it even
        // though the stage check passes.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend done   { to: "+212661234567" template: "t" state: "Fulfilled" }
                WhatsAppSend reopen { to: "+212661234567" template: "t" state: "Accepted" }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("per-state regression must fail");
        // The coarse stage check must NOT fire here (both nodes are Fulfillment).
        assert!(
            !errors
                .iter()
                .any(|e| matches!(e, TypeError::StateMonotonicityViolation { .. })),
            "stage check should be silent on same-stage nodes; got {errors:?}"
        );
        let reg = errors
            .iter()
            .find(|e| matches!(e, TypeError::CommitmentStateRegression { .. }))
            .expect("a CommitmentStateRegression");
        let msg = reg.to_string();
        assert!(msg.contains("Invariant 2"), "got {msg}");
        assert!(msg.contains("per-state"), "got {msg}");
        match reg {
            TypeError::CommitmentStateRegression {
                from_state,
                to_state,
                ..
            } => {
                assert_eq!(from_state, "Fulfilled");
                assert_eq!(to_state, "Accepted");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn check_i2_per_state_blocks_accepted_to_draft() {
        // Accepted -> Draft is a backward edge the stage check cannot see (both
        // declarations could be at one stage); the audit table rejects it.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" state: "Accepted" }
                WhatsAppSend b { to: "+212661234567" template: "t" state: "Draft" }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("Accepted -> Draft must fail");
        assert!(
            errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. })),
            "got {errors:?}"
        );
    }

    #[test]
    fn check_i2_per_state_allows_valid_forward_transition() {
        // Proposed -> Accepted IS in the valid table, so a workflow declaring it
        // compiles. Rigor, not rigidity: the sanctioned forward edge is allowed.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" state: "Proposed" }
                WhatsAppSend b { to: "+212661234567" template: "t" state: "Accepted" }
            }
        "#;
        let errors = check_types(parse_str(src)).err().unwrap_or_default();
        assert!(
            !errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. })),
            "valid forward transition must not be blocked; got {errors:?}"
        );
    }

    #[test]
    fn check_i2_per_state_allows_fulfilled_to_refunded() {
        // Fulfilled -> Refunded is a sanctioned reversal expressed as a forward
        // edge in the model's table — the per-state check must allow it.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" state: "Fulfilled" }
                WhatsAppSend b { to: "+212661234567" template: "t" state: "Refunded" }
            }
        "#;
        let errors = check_types(parse_str(src)).err().unwrap_or_default();
        assert!(
            !errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. })),
            "Fulfilled -> Refunded must compile; got {errors:?}"
        );
    }

    #[test]
    fn check_i2_per_state_skips_undeclared_states() {
        // Honest scope: when nodes declare no explicit `state`, the per-state
        // check contributes nothing — those transitions stay audit-only. A plain
        // monotone workflow has no per-state error.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                CartAbandoned trigger { min_value: Currency(200, MAD) after: Duration(30, minutes) }
                ACPGetCustomerProfile profile { customer_id: trigger.customer_id }
                OrderPlaced ord { min_value: Currency(200, MAD) }
                WhatsAppSend msg { to: "+212661234567" template: "t" }
            }
        "#;
        let errors = check_types(parse_str(src)).err().unwrap_or_default();
        assert!(
            !errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. })),
            "no declared states means no per-state error; got {errors:?}"
        );
    }

    #[test]
    fn check_i2_per_state_unknown_state_name_is_ignored() {
        // A `state` value that is not a known CommitmentState name is ignored by
        // the per-state check (it cannot reason about it) — no false positive.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" state: "NotAState" }
                WhatsAppSend b { to: "+212661234567" template: "t" state: "Accepted" }
            }
        "#;
        let errors = check_types(parse_str(src)).err().unwrap_or_default();
        assert!(
            !errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. })),
            "unknown state name must not produce a per-state error; got {errors:?}"
        );
    }

    #[test]
    fn check_i2_per_state_verdict_matches_audit_layer() {
        // Composition guarantee: the per-state check's verdict for a declared
        // pair is exactly the audit layer's `validate_commitment_transition`
        // verdict — it does not re-encode the table. Spot-check both directions.
        let blocked_src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend a { to: "+212661234567" template: "t" state: "Cancelled" }
                WhatsAppSend b { to: "+212661234567" template: "t" state: "Accepted" }
            }
        "#;
        let compiler_blocks = check_types(parse_str(blocked_src))
            .err()
            .unwrap_or_default()
            .iter()
            .any(|e| matches!(e, TypeError::CommitmentStateRegression { .. }));
        let audit_rejects = validate_commitment_transition(
            &CommitmentState::Cancelled {
                by: PartyID::new("p").unwrap(),
                reason: String::new(),
                at: String::new(),
            },
            &CommitmentState::Accepted,
        )
        .is_err();
        assert_eq!(
            compiler_blocks, audit_rejects,
            "compiler verdict must match audit layer for Cancelled -> Accepted"
        );
        assert!(
            compiler_blocks,
            "Cancelled -> Accepted is a terminal regression"
        );
    }

    #[test]
    fn check_i3_errors_when_accepted_without_capacity_check() {
        // OrderPlaced reaches Commitment(Accepted) with no prior profile fetch.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                OrderPlaced ord {
                    min_value: Currency(200, MAD)
                }
            }
        "#;
        let project = parse_str(src);
        let errors = check_types(project).expect_err("missing capacity check must fail");
        assert!(
            errors
                .iter()
                .any(|e| matches!(e, TypeError::MissingCapacityVerification { .. })),
            "got {errors:?}"
        );
    }

    #[test]
    fn check_i3_passes_when_acp_profile_precedes_accepted() {
        // ACPGetCustomerProfile (capacity substrate) declared before OrderPlaced.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"

                ACPGetCustomerProfile profile {
                    customer_id: "cust_1"
                }

                OrderPlaced ord {
                    min_value: Currency(200, MAD)
                }
            }
        "#;
        let project = parse_str(src);
        assert!(check_types(project).is_ok());
    }

    #[test]
    fn check_i3_passes_when_no_accepted_producing_node() {
        // Cart recovery has no Accepted-producing node, so I-3 does not apply.
        let project = parse_str(FULL_CART_RECOVERY);
        assert!(check_types(project).is_ok());
    }

    // ========================================================================
    // P3 compiler invariant checks — I-4, I-5, I-6.
    // ========================================================================

    #[test]
    fn i4_passes_when_commitment_before_fulfillment() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced ord { min_value: Currency(200, MAD) }
                WhatsAppSend msg { to: "+212661234567" template: "t" }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn i4_errors_when_fulfillment_before_commitment() {
        // WhatsAppSend (Fulfillment) declared before OrderPlaced (Commitment).
        // ACP first keeps I-3 satisfied, isolating the I-4 failure.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                WhatsAppSend msg { to: "+212661234567" template: "t" }
                OrderPlaced ord { min_value: Currency(200, MAD) }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("temporal order must fail");
        assert!(
            errors
                .iter()
                .any(|e| matches!(e, TypeError::TemporalOrderViolation { .. })),
            "got {errors:?}"
        );
    }

    #[test]
    fn i4_passes_when_only_fulfillment_nodes() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                WhatsAppSend msg { to: "+212661234567" template: "t" }
                DelayFor wait { duration: Duration(1, hours) }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn i4_passes_when_only_commitment_nodes() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced ord { min_value: Currency(200, MAD) }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn i5_passes_when_all_instance_names_unique() {
        let project = parse_str(FULL_CART_RECOVERY);
        assert!(check_types(project).is_ok());
    }

    #[test]
    fn i5_errors_on_duplicate_instance_name() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                CartAbandoned dup {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }
                ACPGetCustomerProfile dup { customer_id: "c1" }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("duplicate name must fail");
        assert!(
            errors.iter().any(
                |e| matches!(e, TypeError::DuplicateInstanceName { name, .. } if name == "dup")
            ),
            "got {errors:?}"
        );
    }

    #[test]
    fn i5_error_includes_both_line_numbers() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                CartAbandoned dup {
                    min_value: Currency(200, MAD)
                    after:     Duration(30, minutes)
                }
                ACPGetCustomerProfile dup { customer_id: "c1" }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("duplicate name must fail");
        let dup = errors
            .iter()
            .find_map(|e| match e {
                TypeError::DuplicateInstanceName {
                    first_declared_line,
                    duplicate_line,
                    ..
                } => Some((*first_declared_line, *duplicate_line)),
                _ => None,
            })
            .expect("a DuplicateInstanceName error");
        assert!(
            dup.0 < dup.1,
            "first {} should precede duplicate {}",
            dup.0,
            dup.1
        );
    }

    #[test]
    fn i6_passes_when_single_commitment_node() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced ord { min_value: Currency(1000, MAD) }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn i6_passes_when_child_below_parent() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced parent { min_value: Currency(1000, MAD) }
                OrderPlaced child { min_value: Currency(400, MAD) }
            }
        "#;
        assert!(check_types(parse_str(src)).is_ok());
    }

    #[test]
    fn i6_errors_when_child_exceeds_parent() {
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced parent { min_value: Currency(500, MAD) }
                OrderPlaced child { min_value: Currency(800, MAD) }
            }
        "#;
        let errors = check_types(parse_str(src)).expect_err("child exceeds parent must fail");
        assert!(
            errors
                .iter()
                .any(|e| matches!(e, TypeError::CommitmentTreeInconsistency { .. })),
            "got {errors:?}"
        );
    }

    #[test]
    fn p3_invariant_errors_render_with_guidance() {
        // Each new diagnostic must render a non-empty, actionable message
        // that names its invariant (P-2: a confusing error is a bug).
        let temporal = TypeError::TemporalOrderViolation {
            earlier_node: "msg".to_string(),
            later_node: "ord".to_string(),
            line: 7,
        }
        .to_string();
        assert!(temporal.contains("Line 7") && temporal.contains("Commitment"));

        let dup = TypeError::DuplicateInstanceName {
            name: "dup".to_string(),
            first_declared_line: 4,
            duplicate_line: 9,
        }
        .to_string();
        assert!(dup.contains("line 4") && dup.contains("Line 9") && dup.contains("Invariant 5"));

        let tree = TypeError::CommitmentTreeInconsistency {
            parent_node: "parent".to_string(),
            parent_value: "500 MAD".to_string(),
            child_node: "child".to_string(),
            child_value: "800 MAD".to_string(),
            line: 12,
        }
        .to_string();
        assert!(tree.contains("Invariant 6") && tree.contains("800 MAD"));

        let mixing = TypeError::CurrencyMixing {
            node_type: "CartAbandoned".to_string(),
            instance_name: "trigger".to_string(),
            currencies_found: vec!["EUR".to_string(), "MAD".to_string()],
            line: 5,
        }
        .to_string();
        assert!(mixing.contains("Line 5") && mixing.contains("Invariant 1"));
        assert!(
            !mixing.contains("Warning"),
            "blocking error must not say Warning"
        );

        let mono = TypeError::StateMonotonicityViolation {
            prior_node: "ord".to_string(),
            regressed_node: "occ".to_string(),
            from_stage: "Commitment".to_string(),
            to_stage: "Intent".to_string(),
            line: 6,
        }
        .to_string();
        assert!(mono.contains("Line 6") && mono.contains("Invariant 2"));
    }

    #[test]
    fn i6_skips_when_values_are_references() {
        // Two OrderPlaced with reference values — I-6 cannot compare
        // statically, so it must not flag a tree inconsistency.
        let src = r#"
            project "x" {
                version = "1.0.0"
                tenant  = "t"
                ACPGetCustomerProfile profile { customer_id: "c1" }
                OrderPlaced parent { min_value: profile.spend }
                OrderPlaced child { min_value: profile.spend }
            }
        "#;
        let result = check_types(parse_str(src));
        // Whatever else holds, there must be no commitment-tree error.
        if let Err(errors) = &result {
            assert!(
                !errors
                    .iter()
                    .any(|e| matches!(e, TypeError::CommitmentTreeInconsistency { .. })),
                "I-6 must skip reference values; got {errors:?}"
            );
        }
    }
}
