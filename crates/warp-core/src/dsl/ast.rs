//! Abstract syntax tree for the Warp DSL (v0.1 per ADR-0007).
//!
//! These types are the **shape** the parser produces and the type
//! checker (later session) consumes. They carry only what the syntax
//! itself encodes — no resolved node references, no typed values, no
//! evaluation results. Semantic checks are the next compiler layer's
//! job.
//!
//! Every field here has a single source of truth in the source text:
//! `WarpProject::name` is the string after `project`,
//! `NodeDecl::node_type` is the PascalCase identifier before the
//! instance name, `ConfigValue::Reference { instance, field }` is the
//! exact `<identifier>.<field>` pair that appeared in the body.

use serde::{Deserialize, Serialize};

/// A parsed Warp project — the entire contents of a single `.warp`
/// file.
///
/// Order of `nodes` matches source order. The parser does **not**
/// reorder; downstream layers (graph builder, type checker) walk
/// this in declaration order and reconstruct the dependency graph
/// from the [`ConfigValue::Reference`] entries inside each node's
/// config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarpProject {
    pub name: String,
    pub version: String,
    pub tenant: String,
    pub nodes: Vec<NodeDecl>,
}

/// One node declaration inside a project body.
///
/// `node_type` is the catalog id the type checker will resolve
/// against [`crate::templates`] / the catalog's node registry.
/// `instance_name` is the snake_case handle later declarations
/// dot-reference to read this node's outputs (e.g. `profile.phone`).
/// `config` is the body the merchant filled in for this node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeDecl {
    pub node_type: String,
    pub instance_name: String,
    pub config: Vec<ConfigEntry>,
}

/// One `key: value` line inside a node config block.
///
/// `key` is the field name on the node's input type (e.g. `to`,
/// `template`, `min_value`). `value` is the typed AST for whatever
/// the merchant wrote on the right of the colon — a string literal,
/// a typed `Currency(…)`, a reference, or a nested object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigEntry {
    pub key: String,
    pub value: ConfigValue,
}

/// One value on the right-hand side of a config entry.
///
/// `StringLit` carries the post-unescape text of a `"…"` literal.
/// `Currency` and `Duration` are first-class lexical forms (see
/// ADR-0007 Decision 3) — the lexer lifted the amount and unit out
/// of the source, so the AST holds them as numbers, not as strings.
/// `Reference` is an `<instance>.<field>` lookup; the type checker
/// validates that `instance` was declared earlier and that `field`
/// exists on that node's output type. `Object` is a `{ k: v, … }`
/// inline block — used today by node configs like `params: {…}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigValue {
    StringLit(String),
    Currency { amount: u64, code: String },
    Duration { amount: u64, unit: String },
    Reference { instance: String, field: String },
    Object(Vec<ConfigEntry>),
}
