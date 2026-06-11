//! Prompt builders for the AI builder.
//!
//! Three prompts in v0.1:
//!
//!   1. **System prompt** — pinned context Claude sees on every
//!      request. Materialized from
//!      [`BUILTIN_NODE_SPECS`](crate::dsl::BUILTIN_NODE_SPECS) so
//!      every catalog node change shows up in the prompt without a
//!      manual edit. The grammar surface, the per-node required
//!      inputs, and the worked example all live here.
//!   2. **User prompt** — the merchant's free-text description plus
//!      their tenant id. Whatever language the description came in,
//!      the system prompt's rule #6 forces the output back into the
//!      ASCII `.warp` syntax.
//!   3. **Correction prompt** — used when [`crate::dsl::compile`]
//!      rejected Claude's previous attempt. Carries the rejected
//!      source AND the error list so the next round has every
//!      compiler diagnostic to react to, not just the first.
//!
//! Keeping these as pure functions means the prompt the AI builder
//! sends is identical to the prompt the unit tests assert on — no
//! state, no time-of-day fields, no UUIDs. Reproducibility matters
//! for the prompt eval loop ADR-0004 will turn on later.

use crate::dsl::{NodeSpec, BUILTIN_NODE_SPECS};

/// Render the system prompt. Pulls the node catalog + required-input
/// table from [`BUILTIN_NODE_SPECS`] so adding a new node updates the
/// prompt automatically.
pub fn system_prompt() -> String {
    system_prompt_with(BUILTIN_NODE_SPECS)
}

/// System-prompt builder taking an explicit spec list. The public
/// [`system_prompt`] threads through [`BUILTIN_NODE_SPECS`]; tests use
/// this form to assert the prompt is materialized from the registry
/// rather than hard-coded.
pub fn system_prompt_with(specs: &[NodeSpec]) -> String {
    let mut out = String::new();
    out.push_str(SYSTEM_PROMPT_HEADER);
    out.push_str("\n\nAVAILABLE NODES (use only these, exact spelling):\n");
    for spec in specs {
        out.push_str(&format!("  - {} ({})\n", spec.dsl_name, spec.category));
    }
    out.push_str(SYSTEM_PROMPT_VALUE_TYPES);
    out.push_str("\nREQUIRED INPUTS PER NODE:\n");
    for spec in specs {
        let required = if spec.required_inputs.is_empty() {
            "(none)".to_string()
        } else {
            spec.required_inputs.join(", ")
        };
        let optional = if spec.optional_inputs.is_empty() {
            String::new()
        } else {
            format!("  [optional: {}]", spec.optional_inputs.join(", "))
        };
        out.push_str(&format!(
            "  - {}: {}{}\n",
            spec.dsl_name, required, optional
        ));
    }
    out.push_str(SYSTEM_PROMPT_RULES);
    out.push_str(SYSTEM_PROMPT_EXAMPLE);
    out
}

/// User-facing prompt: the merchant's description + the target tenant.
///
/// The system prompt's rule set tells Claude to output only `.warp`
/// syntax — no markdown fence, no commentary. The builder still runs
/// [`extract_warp_source`](crate::ai_builder::builder::extract_warp_source)
/// defensively to peel a fence off if Claude added one anyway.
pub fn user_prompt(description: &str, tenant_id: &str) -> String {
    format!(
        "Generate a Warp workflow for this merchant request:\n\n\
         {description}\n\n\
         Tenant ID: {tenant_id}\n\n\
         Output only the .warp project file. No other text.",
        description = description.trim(),
        tenant_id = tenant_id,
    )
}

/// Correction prompt — round 2+ of the build loop. Carries every
/// compile error so Claude has the complete diagnostic surface, not
/// just the first failure. Truncates the previous attempt to a
/// reasonable size so a runaway generation doesn't blow the next
/// request's token budget.
pub fn correction_prompt(previous_attempt: &str, errors: &[String]) -> String {
    let joined = errors.join("\n");
    let trimmed_attempt = truncate(previous_attempt, MAX_ATTEMPT_ECHO_BYTES);
    format!(
        "Your previous .warp file had compilation errors:\n\n\
         ERRORS:\n{joined}\n\n\
         YOUR PREVIOUS ATTEMPT:\n{trimmed_attempt}\n\n\
         Fix the errors and output only the corrected .warp file.",
    )
}

/// Soft cap on how much of a failed attempt rides into the correction
/// prompt. A 6-node project is ~600 bytes; 4 KiB leaves headroom for
/// the AI builder's max-rounds=3 default to not balloon mid-loop.
const MAX_ATTEMPT_ECHO_BYTES: usize = 4096;

fn truncate(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    // Slice at a char boundary so unicode doesn't blow up.
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[truncated]", &s[..end])
}

// ---------------------------------------------------------------------------
// Static prompt fragments. Kept as `const` strings so the materialized
// prompt is byte-stable across calls — a property the prompt eval
// pipeline downstream depends on.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_HEADER: &str = "You are the Warp Commerce Workflow Builder.

Warp is a typed commerce workflow language. You generate .warp project
files from natural language descriptions.

WARP SYNTAX (follow exactly):

  project \"{name}\" {
    version = \"1.0.0\"
    tenant  = \"{tenant_id}\"

    {NodeType} {instance_name} {
      {key}: {value}
    }
  }";

const SYSTEM_PROMPT_VALUE_TYPES: &str = "
AVAILABLE CONFIG VALUE TYPES:
  - Strings:    \"value\"
  - Currency:   Currency(200, MAD)        (v0.1 codegen only accepts MAD)
  - Duration:   Duration(30, minutes)     (units: minutes, hours)
  - References: instance_name.field_name  (must point at a previously
                                           declared instance, or the
                                           keyword `trigger`)
";

const SYSTEM_PROMPT_RULES: &str = "
RULES:
  1. Output ONLY valid .warp syntax. No explanations. No markdown
     fences. No preamble. No suffix.
  2. The first node must be a trigger (CartAbandoned or OrderPlaced).
  3. References must refer to instances declared earlier in the same
     project, or to the keyword `trigger` which aliases the first
     trigger node.
  4. Name the first node `trigger` whenever you can — the type
     checker's `trigger` keyword resolves to it implicitly.
  5. WhatsAppSend.to MUST be a reference to a PhoneNumber field
     (e.g. profile.phone). A string literal is rejected.
  6. If the merchant's description is in Arabic, Darija, or French,
     still output `.warp` in the ASCII syntax shown above. The
     language of the description does not change the output format.
";

const SYSTEM_PROMPT_EXAMPLE: &str = "
WORKED EXAMPLE.

Input description (English): \"Send a WhatsApp 30 minutes after cart abandonment\"

Output:
project \"cart_reminder\" {
  version = \"1.0.0\"
  tenant  = \"{tenant_id}\"

  CartAbandoned trigger {
    min_value: Currency(0, MAD)
    after:     Duration(30, minutes)
  }

  ACPGetCustomerProfile profile {
    customer_id: trigger.customer_id
  }

  WhatsAppSend message {
    to:       profile.phone
    template: \"cart_reminder\"
    lang:     profile.language
  }
}
";

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_lists_every_builtin_node() {
        let prompt = system_prompt();
        for spec in BUILTIN_NODE_SPECS {
            assert!(
                prompt.contains(spec.dsl_name),
                "system prompt missing node {:?}",
                spec.dsl_name
            );
        }
    }

    #[test]
    fn system_prompt_lists_required_inputs_for_every_node() {
        let prompt = system_prompt();
        for spec in BUILTIN_NODE_SPECS {
            for req in spec.required_inputs {
                // Each required input must appear at least once in the
                // prompt body — either as part of the per-node
                // required-input list or in the worked example.
                assert!(
                    prompt.contains(req),
                    "system prompt missing required input {:?} for node {:?}",
                    req,
                    spec.dsl_name
                );
            }
        }
    }

    #[test]
    fn system_prompt_names_currency_and_duration_as_first_class() {
        let prompt = system_prompt();
        assert!(prompt.contains("Currency("));
        assert!(prompt.contains("Duration("));
        assert!(prompt.contains("Reference"));
    }

    #[test]
    fn system_prompt_includes_arabic_darija_french_rule() {
        let prompt = system_prompt();
        assert!(prompt.contains("Arabic"));
        assert!(prompt.contains("Darija"));
        assert!(prompt.contains("French"));
    }

    #[test]
    fn user_prompt_includes_description_and_tenant() {
        let p = user_prompt(
            "Send a WhatsApp after cart abandonment",
            "tenant_aimer_prod_001",
        );
        assert!(p.contains("Send a WhatsApp after cart abandonment"));
        assert!(p.contains("tenant_aimer_prod_001"));
        assert!(p.contains("Output only the .warp project file"));
    }

    #[test]
    fn correction_prompt_carries_every_error() {
        let errs = vec![
            "Line 5: Unknown node type 'WhatsappSend'.".to_string(),
            "Line 7: WhatsAppSend 'send' is missing required input 'to'.".to_string(),
        ];
        let p = correction_prompt("project \"x\" { … }", &errs);
        for e in &errs {
            assert!(p.contains(e), "correction prompt missing error: {:?}", e);
        }
        assert!(p.contains("project \"x\""));
        assert!(p.contains("Fix the errors"));
    }

    #[test]
    fn correction_prompt_truncates_huge_attempts() {
        let big = "x".repeat(20_000);
        let p = correction_prompt(&big, &["err".to_string()]);
        // The echoed attempt should be capped at the documented size + tag.
        assert!(p.contains("…[truncated]"), "expected truncation marker");
        assert!(
            p.len() < 6000,
            "correction prompt too large: {} bytes",
            p.len()
        );
    }
}
