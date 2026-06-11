//! Warp DSL code generator v0.1 — the fourth and final compiler layer.
//!
//! Takes a [`TypedProject`] (the type checker's output) and produces a
//! Rust source string that, when compiled and linked against
//! `warp-core` + `warp-catalog`, registers a Restate workflow
//! implementing the project. The generated source uses the *real*
//! catalog types ([`warp_catalog::commerce::*`]); the cargo-check
//! integration test ([`crates/warp-core/tests/codegen_e2e.rs`]) is the
//! definitive gate proof that what we emit is buildable Rust.
//!
//! ## Pipeline
//!
//! ```text
//!   .warp source
//!       └── lexer ──┐
//!                   └── parser ──┐
//!                                └── type_checker ──┐
//!                                                   └── codegen ──> rust_source: String
//! ```
//!
//! [`compile_and_generate`](super::compile_and_generate) is the public
//! end-to-end convenience. The full pipeline lives in
//! [`super::compile`] up through the type checker, and this module
//! extends it to lowered Rust.
//!
//! ## Scope (v0.1)
//!
//! - **In scope:** the six builtin nodes from
//!   [`BUILTIN_NODE_SPECS`](super::type_checker::BUILTIN_NODE_SPECS).
//!   Every other node produces [`CodegenError::UnsupportedNode`].
//! - **In scope:** the four [`ConfigValue`] variants `StringLit`,
//!   `Currency`, `Duration`, `Reference`. `Object` is supported only
//!   inside `WhatsAppSend.params` (mapped to `serde_json::json!`);
//!   other Object positions return [`CodegenError::UnsupportedConfig`].
//! - **In scope:** MAD-coded `Currency` literals. v0.1's
//!   `CartAbandonedConfig.min_value` and `OrderPlacedConfig.min_value`
//!   both accept arbitrary `Currency` codes, but the lone catalog
//!   default is MAD-coded and the spec ships v0.1 as a MENA-first
//!   release (P-7). EUR / USD literals return
//!   [`CodegenError::UnsupportedConfig`].
//! - **Out of scope (Phase 3):** branching, parallel fan-out, dynamic
//!   compilation, custom output types. The generator emits a
//!   linear-only workflow that returns `GeneratedOutput { completed }`
//!   after the last node — the Restate runtime can execute it, but
//!   richer control flow lands when ADR-0008 (workflow control-flow
//!   semantics) is accepted.

use std::collections::HashMap;
use std::fmt::Write as _;

use super::ast::{ConfigEntry, ConfigValue};
use super::type_checker::{TypedNodeDecl, TypedProject};

// ===========================================================================
// Public types.
// ===========================================================================

/// Successful output of [`generate`]. `rust_source` is the file
/// content; downstream tooling writes it to disk and `cargo check`s
/// it. `workflow_name` and `node_count` are echoed back for STATUS-
/// page surfacing and progress telemetry.
#[derive(Debug, Clone)]
pub struct GeneratedCode {
    pub rust_source: String,
    pub workflow_name: String,
    pub node_count: usize,
}

/// One thing the generator refused to lower. v0.1 is intentionally
/// narrow; every "we haven't built that yet" path lives behind a
/// dedicated variant so the AI builder (ADR-0004) can read the error
/// and replan rather than guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodegenError {
    /// `node_type` resolved in the type checker but the generator
    /// doesn't have a lowering rule. Should be unreachable for the
    /// six builtin nodes; reachable when a custom node ships before
    /// codegen learns about it.
    UnsupportedNode {
        node_type: String,
        instance_name: String,
    },
    /// A [`ConfigValue`] variant or shape that v0.1 doesn't support at
    /// this position (e.g. an `Object` outside `WhatsAppSend.params`,
    /// or a non-MAD `Currency` literal).
    UnsupportedConfig {
        node_type: String,
        instance_name: String,
        key: String,
        reason: String,
    },
    /// `Duration({amount}, {unit})` carried an unrecognized unit. Only
    /// `minutes` and `hours` are supported in v0.1 (matching the catalog
    /// trigger configs); seconds + days land when nodes ask for them.
    UnsupportedDurationUnit { unit: String, key: String },
    /// The project has no triggers-category node, so there's no
    /// natural entry shape to lower. Type checker accepts this, but
    /// codegen needs a trigger to know what `GeneratedWorkflowInput`
    /// should carry.
    MissingTrigger,
}

impl std::fmt::Display for CodegenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodegenError::UnsupportedNode {
                node_type,
                instance_name,
            } => write!(
                f,
                "codegen does not yet support node type {:?} (instance {:?})",
                node_type, instance_name
            ),
            CodegenError::UnsupportedConfig {
                node_type,
                instance_name,
                key,
                reason,
            } => write!(
                f,
                "codegen rejected {}.{} on {}.{}: {}",
                node_type, key, node_type, instance_name, reason
            ),
            CodegenError::UnsupportedDurationUnit { unit, key } => write!(
                f,
                "codegen rejected Duration unit {:?} on key {:?} — only `minutes` and `hours` are supported in v0.1",
                unit, key
            ),
            CodegenError::MissingTrigger => write!(
                f,
                "codegen requires at least one triggers-category node to derive the workflow input shape"
            ),
        }
    }
}

impl std::error::Error for CodegenError {}

// ===========================================================================
// Public entry point.
// ===========================================================================

/// Lower a type-checked project into a Rust source file.
///
/// Returns [`CodegenError`] for any node type, config shape, or
/// trigger arrangement v0.1 doesn't handle (see the module docs for
/// the scope list).
pub fn generate(project: &TypedProject) -> Result<GeneratedCode, CodegenError> {
    let trigger = project
        .nodes
        .iter()
        .find(|n| n.category == "triggers")
        .ok_or(CodegenError::MissingTrigger)?
        .clone();

    // Walk the nodes in declaration order — type checker already
    // validated that references only point at earlier instances, so
    // this is the lowering order.
    let mut body = String::new();
    // Tracks `instance_name -> node_type` so we can pick the right
    // field on `{instance}_output` at reference resolution time.
    let mut bindings: HashMap<String, String> = HashMap::new();

    for node in &project.nodes {
        emit_node_block(&mut body, node, &bindings, &trigger)?;
        bindings.insert(node.instance_name.clone(), node.node_type.clone());
    }

    let mut out = String::new();
    emit_header(&mut out, &project.name);
    emit_imports(&mut out);
    emit_input_struct(&mut out, &trigger);
    emit_output_struct(&mut out);
    emit_workflow_trait(&mut out, &project.name);
    emit_workflow_impl(&mut out, &project.name, &body);

    Ok(GeneratedCode {
        rust_source: out,
        workflow_name: project.name.clone(),
        node_count: project.nodes.len(),
    })
}

// ===========================================================================
// Header / imports / static scaffolding.
// ===========================================================================

fn emit_header(out: &mut String, project_name: &str) {
    let _ = writeln!(out, "// GENERATED BY WARP COMPILER v0.1 — DO NOT EDIT");
    let _ = writeln!(out, "// Source: {}.warp", project_name);
    let _ = writeln!(out, "// Project: {}", project_name);
    let _ = writeln!(out);
}

fn emit_imports(out: &mut String) {
    let _ = writeln!(
        out,
        "#![allow(dead_code, unused_imports, unused_variables)]"
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "use restate_sdk::prelude::*;");
    let _ = writeln!(out, "use rust_decimal::Decimal;");
    let _ = writeln!(out, "use serde::{{Deserialize, Serialize}};");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "use warp_core::types::commerce::{{Currency, CurrencyCode, Language, PhoneNumber, Platform, TenantId, tenant_workflow_key}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::communication::whatsapp_send::{{WhatsAppLanguage, WhatsAppSendClient, WhatsAppSendInput}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::intelligence::acp_evaluate_strategy::{{ACPEvaluateStrategyClient, ACPEvaluateStrategyInput}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::intelligence::acp_get_customer_profile::{{ACPGetCustomerProfileClient, ACPGetCustomerProfileInput}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::timing::delay_for::{{DelayForClient, DelayForInput}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::triggers::cart_abandoned::{{CartAbandonedClient, CartAbandonedConfig, CartAbandonedInput}};"
    );
    let _ = writeln!(
        out,
        "use warp_catalog::commerce::triggers::order_placed::{{OrderPlacedClient, OrderPlacedConfig, OrderPlacedInput}};"
    );
    let _ = writeln!(out);
}

fn emit_input_struct(out: &mut String, trigger: &TypedNodeDecl) {
    let _ = writeln!(
        out,
        "/// Generated entry-point input. Fields are derived from the project's"
    );
    let _ = writeln!(
        out,
        "/// trigger node ({} → {}); downstream nodes pull from",
        trigger.node_type, trigger.instance_name
    );
    let _ = writeln!(
        out,
        "/// `{}_output` rather than from this struct.",
        trigger.instance_name
    );
    let _ = writeln!(out, "#[derive(Debug, Clone, Serialize, Deserialize)]");
    let _ = writeln!(out, "pub struct GeneratedWorkflowInput {{");
    let _ = writeln!(out, "    pub tenant_id: TenantId,");
    let _ = writeln!(out, "    pub customer_id: String,");
    match trigger.node_type.as_str() {
        "CartAbandoned" => {
            let _ = writeln!(out, "    pub session_id: String,");
            let _ = writeln!(out, "    pub cart_value_str: String,");
            let _ = writeln!(out, "    pub item_count: u32,");
            let _ = writeln!(out, "    pub abandoned_at: String,");
            let _ = writeln!(out, "    pub currency_code: CurrencyCode,");
        }
        "OrderPlaced" => {
            let _ = writeln!(out, "    pub order_id: String,");
            let _ = writeln!(out, "    pub order_value_str: String,");
            let _ = writeln!(out, "    pub item_count: u32,");
            let _ = writeln!(out, "    pub placed_at: String,");
            let _ = writeln!(out, "    pub currency_code: CurrencyCode,");
        }
        _ => {
            // type checker already validated this is a triggers
            // category; an unknown one is a build-time bug, not
            // runtime data.
            let _ = writeln!(out, "    // unknown trigger type, no extra fields");
        }
    }
    let _ = writeln!(out, "    pub acp_base_url: String,");
    let _ = writeln!(out, "    pub acp_endpoint: String,");
    let _ = writeln!(out, "}}");
    let _ = writeln!(out);
}

fn emit_output_struct(out: &mut String) {
    let _ = writeln!(out, "#[derive(Debug, Clone, Serialize, Deserialize)]");
    let _ = writeln!(out, "pub struct GeneratedOutput {{");
    let _ = writeln!(out, "    pub completed: bool,");
    let _ = writeln!(out, "}}");
    let _ = writeln!(out);
}

fn emit_workflow_trait(out: &mut String, project_name: &str) {
    let pascal = pascal_case(project_name);
    let _ = writeln!(out, "#[restate_sdk::workflow]");
    let _ = writeln!(out, "pub trait Generated{} {{", pascal);
    let _ = writeln!(
        out,
        "    async fn run(input: Json<GeneratedWorkflowInput>) -> Result<Json<GeneratedOutput>, HandlerError>;"
    );
    let _ = writeln!(out, "}}");
    let _ = writeln!(out);
}

fn emit_workflow_impl(out: &mut String, project_name: &str, body: &str) {
    let pascal = pascal_case(project_name);
    let _ = writeln!(out, "pub struct Generated{}Impl;", pascal);
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "impl Generated{} for Generated{}Impl {{",
        pascal, pascal
    );
    let _ = writeln!(out, "    async fn run(");
    let _ = writeln!(out, "        &self,");
    let _ = writeln!(out, "        ctx: WorkflowContext<'_>,");
    let _ = writeln!(out, "        Json(input): Json<GeneratedWorkflowInput>,");
    let _ = writeln!(
        out,
        "    ) -> Result<Json<GeneratedOutput>, HandlerError> {{"
    );
    out.push_str(body);
    let _ = writeln!(
        out,
        "        Ok(Json(GeneratedOutput {{ completed: true }}))"
    );
    let _ = writeln!(out, "    }}");
    let _ = writeln!(out, "}}");
}

// ===========================================================================
// Per-node lowering.
// ===========================================================================

fn emit_node_block(
    out: &mut String,
    node: &TypedNodeDecl,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<(), CodegenError> {
    let _ = writeln!(
        out,
        "        // Node: {} ({})",
        node.instance_name, node.node_type
    );
    match node.node_type.as_str() {
        "CartAbandoned" => emit_cart_abandoned(out, node)?,
        "OrderPlaced" => emit_order_placed(out, node)?,
        "WhatsAppSend" => emit_whatsapp_send(out, node, bindings, trigger)?,
        "DelayFor" => emit_delay_for(out, node, bindings, trigger)?,
        "ACPGetCustomerProfile" => emit_acp_get_profile(out, node, bindings, trigger)?,
        "ACPEvaluateStrategy" => emit_acp_evaluate_strategy(out, node, bindings, trigger)?,
        other => {
            return Err(CodegenError::UnsupportedNode {
                node_type: other.to_string(),
                instance_name: node.instance_name.clone(),
            });
        }
    }
    let _ = writeln!(out);
    Ok(())
}

fn emit_cart_abandoned(out: &mut String, node: &TypedNodeDecl) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    let min_value = currency_literal(node, "min_value")?;
    let after_minutes = duration_literal(node, "after", DurationUnit::Minutes)?;
    let _ = writeln!(
        out,
        "        let key = tenant_workflow_key(&input.tenant_id, &input.session_id);"
    );
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(
        out,
        "            .workflow_client::<CartAbandonedClient>(key)"
    );
    let _ = writeln!(out, "            .run(Json(CartAbandonedInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(
        out,
        "                customer_id: input.customer_id.clone(),"
    );
    let _ = writeln!(out, "                session_id: input.session_id.clone(),");
    let _ = writeln!(
        out,
        "                cart_value_str: input.cart_value_str.clone(),"
    );
    let _ = writeln!(out, "                item_count: input.item_count,");
    let _ = writeln!(
        out,
        "                abandoned_at: input.abandoned_at.clone(),"
    );
    let _ = writeln!(out, "                currency_code: input.currency_code,");
    let _ = writeln!(out, "                config: Some(CartAbandonedConfig {{");
    let _ = writeln!(out, "                    min_value: {},", min_value);
    let _ = writeln!(out, "                    after_minutes: {},", after_minutes);
    let _ = writeln!(out, "                    platform: Platform::Agora,");
    let _ = writeln!(out, "                }}),");
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

fn emit_order_placed(out: &mut String, node: &TypedNodeDecl) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    let min_value = currency_literal(node, "min_value")?;
    let _ = writeln!(
        out,
        "        let key = tenant_workflow_key(&input.tenant_id, &input.order_id);"
    );
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(
        out,
        "            .workflow_client::<OrderPlacedClient>(key)"
    );
    let _ = writeln!(out, "            .run(Json(OrderPlacedInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(out, "                order_id: input.order_id.clone(),");
    let _ = writeln!(
        out,
        "                customer_id: input.customer_id.clone(),"
    );
    let _ = writeln!(
        out,
        "                order_value_str: input.order_value_str.clone(),"
    );
    let _ = writeln!(out, "                item_count: input.item_count,");
    let _ = writeln!(out, "                placed_at: input.placed_at.clone(),");
    let _ = writeln!(out, "                delivery_address: None,");
    let _ = writeln!(out, "                currency_code: input.currency_code,");
    let _ = writeln!(out, "                config: Some(OrderPlacedConfig {{");
    let _ = writeln!(out, "                    min_value: {},", min_value);
    let _ = writeln!(out, "                    platform: Platform::Agora,");
    let _ = writeln!(out, "                }}),");
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

fn emit_whatsapp_send(
    out: &mut String,
    node: &TypedNodeDecl,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    let to = phone_field(node, "to", bindings, trigger)?;
    let template = string_field(node, "template")?;
    let language = language_field(node, "lang", bindings)?;
    let params = params_field(node, "params", bindings, trigger)?;
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(out, "            .service_client::<WhatsAppSendClient>()");
    let _ = writeln!(out, "            .run(Json(WhatsAppSendInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(out, "                to: {},", to);
    let _ = writeln!(out, "                template_id: {},", template);
    let _ = writeln!(out, "                language: {},", language);
    let _ = writeln!(out, "                params: {},", params);
    let _ = writeln!(
        out,
        "                acp_endpoint: input.acp_endpoint.clone(),"
    );
    let _ = writeln!(out, "                mock: true,");
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

fn emit_delay_for(
    out: &mut String,
    node: &TypedNodeDecl,
    _bindings: &HashMap<String, String>,
    _trigger: &TypedNodeDecl,
) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    // DelayFor.duration takes seconds, so unit needs to lower into seconds.
    let duration_seconds = duration_literal(node, "duration", DurationUnit::Seconds)?;
    let reason = match find_entry(node, "reason") {
        Some(entry) => match &entry.value {
            ConfigValue::StringLit(s) => format!("Some({:?}.to_string())", s),
            _ => "None".to_string(),
        },
        None => "None".to_string(),
    };
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(out, "            .service_client::<DelayForClient>()");
    let _ = writeln!(out, "            .run(Json(DelayForInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(
        out,
        "                duration_seconds: {},",
        duration_seconds
    );
    let _ = writeln!(out, "                reason: {},", reason);
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

fn emit_acp_get_profile(
    out: &mut String,
    node: &TypedNodeDecl,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    let customer_id = string_or_reference_field(node, "customer_id", bindings, trigger)?;
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(
        out,
        "            .service_client::<ACPGetCustomerProfileClient>()"
    );
    let _ = writeln!(out, "            .run(Json(ACPGetCustomerProfileInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(out, "                customer_id: {},", customer_id);
    let _ = writeln!(
        out,
        "                acp_base_url: input.acp_base_url.clone(),"
    );
    let _ = writeln!(out, "                mock: true,");
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

fn emit_acp_evaluate_strategy(
    out: &mut String,
    node: &TypedNodeDecl,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<(), CodegenError> {
    let var = output_var(&node.instance_name);
    let customer_id = string_or_reference_field(node, "customer_id", bindings, trigger)?;
    let _ = writeln!(out, "        let Json({}) = ctx", var);
    let _ = writeln!(
        out,
        "            .service_client::<ACPEvaluateStrategyClient>()"
    );
    let _ = writeln!(out, "            .run(Json(ACPEvaluateStrategyInput {{");
    let _ = writeln!(out, "                tenant_id: input.tenant_id.clone(),");
    let _ = writeln!(out, "                customer_id: {},", customer_id);
    let _ = writeln!(out, "                cart_state: serde_json::json!({{}}),");
    let _ = writeln!(
        out,
        "                acp_base_url: input.acp_base_url.clone(),"
    );
    let _ = writeln!(out, "                mock: true,");
    let _ = writeln!(out, "            }}))");
    let _ = writeln!(out, "            .call()");
    let _ = writeln!(out, "            .await?;");
    Ok(())
}

// ===========================================================================
// ConfigValue → Rust expression helpers. Each takes the field name on
// the destination input type and the DSL config entry; emits a Rust
// expression that produces a value of the field's static type.
// ===========================================================================

fn currency_literal(node: &TypedNodeDecl, key: &str) -> Result<String, CodegenError> {
    let entry = find_entry(node, key);
    match entry.map(|e| &e.value) {
        Some(ConfigValue::Currency { amount, code }) => match code.as_str() {
            "MAD" => Ok(format!("Currency::mad(Decimal::from({}u64))", amount)),
            other => Err(CodegenError::UnsupportedConfig {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                key: key.to_string(),
                reason: format!("v0.1 only emits MAD-coded Currency literals; got {}", other),
            }),
        },
        Some(other) => Err(CodegenError::UnsupportedConfig {
            node_type: node.node_type.clone(),
            instance_name: node.instance_name.clone(),
            key: key.to_string(),
            reason: format!("expected Currency literal, got {:?}", other),
        }),
        None => Ok("Currency::mad(Decimal::from(0u64))".to_string()),
    }
}

#[derive(Debug, Clone, Copy)]
enum DurationUnit {
    Minutes,
    Seconds,
}

fn duration_literal(
    node: &TypedNodeDecl,
    key: &str,
    out_unit: DurationUnit,
) -> Result<String, CodegenError> {
    let entry = find_entry(node, key);
    let (amount, unit) = match entry.map(|e| &e.value) {
        Some(ConfigValue::Duration { amount, unit }) => (*amount, unit.clone()),
        Some(other) => {
            return Err(CodegenError::UnsupportedConfig {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                key: key.to_string(),
                reason: format!("expected Duration literal, got {:?}", other),
            });
        }
        None => {
            return Ok("0u64".to_string());
        }
    };

    let seconds = match unit.as_str() {
        "minutes" => amount.saturating_mul(60),
        "hours" => amount.saturating_mul(3600),
        other => {
            return Err(CodegenError::UnsupportedDurationUnit {
                unit: other.to_string(),
                key: key.to_string(),
            });
        }
    };
    let lowered = match out_unit {
        DurationUnit::Minutes => seconds / 60,
        DurationUnit::Seconds => seconds,
    };
    Ok(format!("{}u64", lowered))
}

fn string_field(node: &TypedNodeDecl, key: &str) -> Result<String, CodegenError> {
    let entry = find_entry(node, key).ok_or_else(|| CodegenError::UnsupportedConfig {
        node_type: node.node_type.clone(),
        instance_name: node.instance_name.clone(),
        key: key.to_string(),
        reason: "required string field absent (type checker should have caught)".to_string(),
    })?;
    match &entry.value {
        ConfigValue::StringLit(s) => Ok(format!("{:?}.to_string()", s)),
        other => Err(CodegenError::UnsupportedConfig {
            node_type: node.node_type.clone(),
            instance_name: node.instance_name.clone(),
            key: key.to_string(),
            reason: format!("expected string literal, got {:?}", other),
        }),
    }
}

fn string_or_reference_field(
    node: &TypedNodeDecl,
    key: &str,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<String, CodegenError> {
    let entry = find_entry(node, key).ok_or_else(|| CodegenError::UnsupportedConfig {
        node_type: node.node_type.clone(),
        instance_name: node.instance_name.clone(),
        key: key.to_string(),
        reason: "required field absent (type checker should have caught)".to_string(),
    })?;
    match &entry.value {
        ConfigValue::StringLit(s) => Ok(format!("{:?}.to_string()", s)),
        ConfigValue::Reference { instance, field } => Ok(format!(
            "{}.{}.clone()",
            resolve_reference_var(instance, bindings, trigger),
            field
        )),
        other => Err(CodegenError::UnsupportedConfig {
            node_type: node.node_type.clone(),
            instance_name: node.instance_name.clone(),
            key: key.to_string(),
            reason: format!("expected string or reference, got {:?}", other),
        }),
    }
}

fn phone_field(
    node: &TypedNodeDecl,
    key: &str,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<String, CodegenError> {
    let entry = find_entry(node, key).ok_or_else(|| CodegenError::UnsupportedConfig {
        node_type: node.node_type.clone(),
        instance_name: node.instance_name.clone(),
        key: key.to_string(),
        reason: "WhatsAppSend.to is required".to_string(),
    })?;
    match &entry.value {
        ConfigValue::Reference { instance, field } => Ok(format!(
            "{}.{}.clone()",
            resolve_reference_var(instance, bindings, trigger),
            field
        )),
        other => Err(CodegenError::UnsupportedConfig {
            node_type: node.node_type.clone(),
            instance_name: node.instance_name.clone(),
            key: key.to_string(),
            reason: format!(
                "WhatsAppSend.to must be a Reference to a PhoneNumber (a string literal can't be a PhoneNumber); got {:?}",
                other
            ),
        }),
    }
}

fn language_field(
    node: &TypedNodeDecl,
    key: &str,
    bindings: &HashMap<String, String>,
) -> Result<String, CodegenError> {
    match find_entry(node, key) {
        None => Ok("WhatsAppLanguage::English".to_string()),
        Some(entry) => match &entry.value {
            ConfigValue::Reference { instance, field } => {
                // Resolve via from(Language) → WhatsAppLanguage conversion.
                // Type checker has already validated the reference points at
                // a declared instance, so the binding lookup is informational
                // — we always emit the {instance}_output variable.
                let _seen = bindings.contains_key(instance);
                let var = output_var(instance);
                Ok(format!("WhatsAppLanguage::from({}.{})", var, field))
            }
            ConfigValue::StringLit(s) => match s.to_ascii_lowercase().as_str() {
                "arabic" => Ok("WhatsAppLanguage::Arabic".to_string()),
                "french" => Ok("WhatsAppLanguage::French".to_string()),
                "english" => Ok("WhatsAppLanguage::English".to_string()),
                "darija" => Ok("WhatsAppLanguage::Darija".to_string()),
                other => Err(CodegenError::UnsupportedConfig {
                    node_type: node.node_type.clone(),
                    instance_name: node.instance_name.clone(),
                    key: key.to_string(),
                    reason: format!(
                        "lang must be one of arabic|french|english|darija; got {:?}",
                        other
                    ),
                }),
            },
            other => Err(CodegenError::UnsupportedConfig {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                key: key.to_string(),
                reason: format!("expected string literal or Reference, got {:?}", other),
            }),
        },
    }
}

/// `params: { … }` for WhatsAppSend. Lowers a one-level Object of
/// `key: <StringLit|Reference>` into a `serde_json::json!({…})`
/// expression. Anything richer (nested Object, Currency / Duration
/// inside params) returns [`CodegenError::UnsupportedConfig`] —
/// merchants who need that today can `params: {}` and bake the
/// dynamic content into the WhatsApp template upstream.
fn params_field(
    node: &TypedNodeDecl,
    key: &str,
    bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> Result<String, CodegenError> {
    let entry = match find_entry(node, key) {
        Some(e) => e,
        None => return Ok("serde_json::json!({})".to_string()),
    };
    let entries = match &entry.value {
        ConfigValue::Object(entries) => entries,
        other => {
            return Err(CodegenError::UnsupportedConfig {
                node_type: node.node_type.clone(),
                instance_name: node.instance_name.clone(),
                key: key.to_string(),
                reason: format!("params must be an Object, got {:?}", other),
            });
        }
    };
    let mut pieces: Vec<String> = Vec::new();
    for inner in entries {
        let value_expr = match &inner.value {
            ConfigValue::StringLit(s) => format!("{:?}", s),
            ConfigValue::Reference { instance, field } => {
                format!(
                    "format!(\"{{}}\", {}.{})",
                    resolve_reference_var(instance, bindings, trigger),
                    field
                )
            }
            other => {
                return Err(CodegenError::UnsupportedConfig {
                    node_type: node.node_type.clone(),
                    instance_name: node.instance_name.clone(),
                    key: key.to_string(),
                    reason: format!(
                        "params.{} must be a string literal or a Reference; got {:?}",
                        inner.key, other
                    ),
                });
            }
        };
        pieces.push(format!("{:?}: {}", inner.key, value_expr));
    }
    Ok(format!("serde_json::json!({{ {} }})", pieces.join(", ")))
}

// ===========================================================================
// Reference / variable helpers.
// ===========================================================================

/// Returns the variable name (e.g. `trigger_output`, `profile_output`)
/// for a DSL reference. The `trigger` keyword always resolves to the
/// first triggers-category node's output var.
fn resolve_reference_var(
    instance: &str,
    _bindings: &HashMap<String, String>,
    trigger: &TypedNodeDecl,
) -> String {
    if instance == "trigger" {
        output_var(&trigger.instance_name)
    } else {
        output_var(instance)
    }
}

fn output_var(instance_name: &str) -> String {
    format!("{}_output", instance_name)
}

fn find_entry<'a>(node: &'a TypedNodeDecl, key: &str) -> Option<&'a ConfigEntry> {
    node.config.iter().find(|e| e.key == key)
}

/// snake_case → PascalCase for generated trait names.
/// `cart_recovery` → `CartRecovery`.
fn pascal_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut capitalize = true;
    for c in name.chars() {
        if c == '_' || c == '-' || c == ' ' {
            capitalize = true;
            continue;
        }
        if capitalize {
            for u in c.to_uppercase() {
                out.push(u);
            }
            capitalize = false;
        } else {
            out.push(c);
        }
    }
    out
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::compile;

    fn compile_to_typed(src: &str) -> TypedProject {
        compile(src)
            .expect("source must compile through type-check")
            .project
    }

    const MINIMAL_PROJECT: &str = r#"
        project "single_node" {
            version = "1.0.0"
            tenant  = "tenant_x"

            CartAbandoned trigger {
                min_value: Currency(200, MAD)
                after:     Duration(30, minutes)
            }
        }
    "#;

    #[test]
    fn codegen_produces_rust_source_for_minimal_project() {
        let typed = compile_to_typed(MINIMAL_PROJECT);
        let gen = generate(&typed).expect("codegen must succeed");
        // Workflow name echoes the project name.
        assert_eq!(gen.workflow_name, "single_node");
        assert_eq!(gen.node_count, 1);
        // Structural markers in the generated source.
        assert!(
            gen.rust_source.contains("CartAbandonedInput"),
            "expected CartAbandonedInput in:\n{}",
            gen.rust_source
        );
        // Generated trait name is PascalCase of the project name with
        // the "Generated" prefix.
        assert!(
            gen.rust_source.contains("pub trait GeneratedSingleNode"),
            "expected `pub trait GeneratedSingleNode`, got:\n{}",
            gen.rust_source
        );
        // The Currency literal lowered to MAD form.
        assert!(
            gen.rust_source
                .contains("Currency::mad(Decimal::from(200u64))"),
            "expected Currency::mad literal, got:\n{}",
            gen.rust_source
        );
        // The Duration(30, minutes) lowered to `30u64` for after_minutes.
        assert!(
            gen.rust_source.contains("after_minutes: 30u64,"),
            "expected after_minutes: 30u64, got:\n{}",
            gen.rust_source
        );
    }

    const REFERENCE_PROJECT: &str = r#"
        project "ref_project" {
            version = "1.0.0"
            tenant  = "tenant_x"

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
        }
    "#;

    #[test]
    fn codegen_resolves_references_correctly() {
        let typed = compile_to_typed(REFERENCE_PROJECT);
        let gen = generate(&typed).expect("codegen must succeed");
        // profile.phone → profile_output.phone.clone() on the WhatsApp `to:` slot.
        assert!(
            gen.rust_source
                .contains("to: profile_output.phone.clone(),"),
            "expected to: profile_output.phone.clone(), got:\n{}",
            gen.rust_source
        );
        // trigger.customer_id → trigger_output.customer_id.clone() on the ACP `customer_id:` slot.
        assert!(
            gen.rust_source
                .contains("customer_id: trigger_output.customer_id.clone(),"),
            "expected customer_id: trigger_output.customer_id.clone(), got:\n{}",
            gen.rust_source
        );
        // profile.language → WhatsAppLanguage::from(profile_output.language) on `lang:`.
        assert!(
            gen.rust_source
                .contains("language: WhatsAppLanguage::from(profile_output.language),"),
            "expected language: WhatsAppLanguage::from(profile_output.language), got:\n{}",
            gen.rust_source
        );
    }

    const THREE_NODE_PROJECT: &str = r#"
        project "order_project" {
            version = "1.0.0"
            tenant  = "tenant_x"

            CartAbandoned a {
                min_value: Currency(100, MAD)
                after:     Duration(5, minutes)
            }

            DelayFor b {
                duration: Duration(1, hours)
            }

            ACPGetCustomerProfile c {
                customer_id: a.customer_id
            }
        }
    "#;

    #[test]
    fn codegen_produces_nodes_in_declaration_order() {
        let typed = compile_to_typed(THREE_NODE_PROJECT);
        let gen = generate(&typed).expect("codegen must succeed");
        let src = &gen.rust_source;
        let pos_a = src.find("Node: a (CartAbandoned)").expect("node a present");
        let pos_b = src.find("Node: b (DelayFor)").expect("node b present");
        let pos_c = src
            .find("Node: c (ACPGetCustomerProfile)")
            .expect("node c present");
        assert!(pos_a < pos_b, "node a must come before node b in:\n{}", src);
        assert!(pos_b < pos_c, "node b must come before node c in:\n{}", src);
    }

    #[test]
    fn codegen_handles_currency_config_value() {
        // Currency(750, MAD) → Currency::mad(Decimal::from(750u64))
        let src = r#"
            project "currency_test" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(750, MAD)
                    after:     Duration(0, minutes)
                }
            }
        "#;
        let typed = compile_to_typed(src);
        let gen = generate(&typed).expect("codegen must succeed");
        assert!(
            gen.rust_source
                .contains("Currency::mad(Decimal::from(750u64))"),
            "expected Currency::mad(Decimal::from(750u64)), got:\n{}",
            gen.rust_source
        );
    }

    #[test]
    fn codegen_handles_duration_in_hours() {
        // Duration(24, hours) on DelayFor.duration must lower to
        // duration_seconds: 24 * 3600 = 86400.
        let src = r#"
            project "duration_test" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(1, MAD)
                    after:     Duration(0, minutes)
                }

                DelayFor wait {
                    duration: Duration(24, hours)
                }
            }
        "#;
        let typed = compile_to_typed(src);
        let gen = generate(&typed).expect("codegen must succeed");
        // 24 hours = 86_400 seconds — what DelayForInput.duration_seconds wants.
        assert!(
            gen.rust_source.contains("duration_seconds: 86400u64,"),
            "expected duration_seconds: 86400u64, got:\n{}",
            gen.rust_source
        );
        // And the upstream CartAbandoned still gets the minutes lowering.
        assert!(
            gen.rust_source.contains("after_minutes: 0u64,"),
            "expected after_minutes: 0u64 on the trigger, got:\n{}",
            gen.rust_source
        );
    }

    #[test]
    fn codegen_rejects_non_mad_currency_with_clear_error() {
        // Currency(20, EUR) is rejected in v0.1 — the catalog's MAD-only
        // posture (P-7) is the explicit lowering boundary.
        let src = r#"
            project "eur_test" {
                version = "1.0.0"
                tenant  = "t"

                CartAbandoned trigger {
                    min_value: Currency(20, EUR)
                    after:     Duration(0, minutes)
                }
            }
        "#;
        let typed = compile_to_typed(src);
        let err = generate(&typed).expect_err("non-MAD must be rejected by codegen");
        match err {
            CodegenError::UnsupportedConfig { reason, .. } => {
                assert!(
                    reason.contains("MAD"),
                    "expected reason to mention MAD constraint, got {:?}",
                    reason
                );
            }
            other => panic!("expected UnsupportedConfig, got {:?}", other),
        }
    }

    #[test]
    fn codegen_full_cart_recovery_emits_six_node_blocks() {
        // The full ADR-0007 cart-recovery example — exercises every
        // builtin node type the v0.1 codegen knows about, plus the
        // `trigger` keyword alias on ACPEvaluateStrategy.
        let src = r#"
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
                }
            }
        "#;
        let typed = compile_to_typed(src);
        let gen = generate(&typed).expect("full chain must codegen");
        assert_eq!(gen.node_count, 6);
        // Every node block leaves a comment marker — count them.
        let block_count = gen.rust_source.matches("// Node:").count();
        assert_eq!(
            block_count, 6,
            "expected 6 // Node: markers, got {block_count} in:\n{}",
            gen.rust_source
        );
        // Both WhatsApp sends share the same Reference (profile.phone)
        // so both render the same lowering — confirms reference
        // resolution is consistent across sites.
        assert_eq!(
            gen.rust_source
                .matches("to: profile_output.phone.clone(),")
                .count(),
            2
        );
    }
}
