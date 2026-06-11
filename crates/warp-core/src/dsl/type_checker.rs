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
    /// CHECK I-1 (Value Conservation, warning-level at P2): a single node
    /// references more than one currency code. Surfaced by
    /// [`check_currency_mixing`] — **not** pushed by [`check_types`], so it
    /// never fails compilation. The full dataflow check is later work.
    CurrencyMixingWarning {
        node_type: String,
        instance_name: String,
        currencies_found: Vec<String>,
        line: usize,
    },
    /// CHECK I-2 (State Monotonicity) placeholder. **Never emitted** — it
    /// documents that the full workflow-level monotonicity check is deferred
    /// to P3 (it needs per-node state-transition annotations in the node
    /// registry that do not exist yet). The type-level guarantee already
    /// holds in `types::model::validate_commitment_transition`.
    StateMonotonicityNotChecked { workflow_name: String },
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
            TypeError::StateMonotonicityNotChecked { workflow_name } => write!(
                f,
                "State monotonicity for workflow '{}' is enforced at the type level by \
                 validate_commitment_transition; the workflow-level compiler check is deferred \
                 (P3 placeholder — never emitted).",
                workflow_name
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

    // CHECK I-2 (State Monotonicity) is intentionally NOT performed here.
    // TODO P3: implement the full workflow-level monotonicity check once the
    // node registry carries per-node Commitment-state-transition annotations.
    // Until then, monotonicity is enforced at the type level by
    // `types::model::validate_commitment_transition`. The
    // `TypeError::StateMonotonicityNotChecked` placeholder documents this and
    // is never emitted.

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
    fn check_i2_placeholder_does_not_error() {
        // I-2 is deferred; a valid workflow must type-check, and the
        // placeholder variant is never produced (only renders for docs).
        let project = parse_str(FULL_CART_RECOVERY);
        assert!(check_types(project).is_ok());
        let msg = TypeError::StateMonotonicityNotChecked {
            workflow_name: "cart_recovery".to_string(),
        }
        .to_string();
        assert!(!msg.is_empty());
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
