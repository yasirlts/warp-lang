//! Warp DSL — the textual language merchants and the AI builder write
//! workflows in.
//!
//! Pipeline stages (each shipped in its own session):
//!
//! 1. **Lexer ([`lexer`])** — tokenize `.warp` source per ADR-0007.
//!    Recognizes commerce-type literals (`Currency(…)`, `Duration(…)`)
//!    and references (`profile.phone`) as first-class tokens.
//! 2. **Parser ([`parser`])** — consume tokens into the [`ast::WarpProject`]
//!    tree. Syntax-only; does not consult any node registry.
//! 3. **Type checker ([`type_checker`])** — walk the AST, resolve node
//!    types against [`type_checker::BUILTIN_NODE_SPECS`], validate
//!    every `<instance>.<field>` reference against the upstream node
//!    declaration order, and check that every node's required inputs
//!    are present. Emits Warp-shaped compile errors per P-2.
//! 4. **Code generator ([`codegen`])** — lower the typed AST into a
//!    Rust source string that registers a Restate workflow against the
//!    real catalog types. The cargo-check integration test in
//!    `crates/warp-core/tests/codegen_e2e.rs` is the definitive gate
//!    proof that the emitted source compiles.
//!
//! ## Compiling a project end-to-end
//!
//! ```
//! use warp_core::dsl;
//!
//! let src = r#"
//!     project "minimal" {
//!         version = "1.0.0"
//!         tenant  = "tenant_x"
//!         CartAbandoned trigger {
//!             min_value: Currency(200, MAD)
//!             after:     Duration(30, minutes)
//!         }
//!     }
//! "#;
//! let result = dsl::compile(src).expect("must compile");
//! assert_eq!(result.project.nodes.len(), 1);
//! assert_eq!(result.project.nodes[0].category, "triggers");
//! assert!(result.warnings.is_empty());
//! ```

pub mod ast;
pub mod codegen;
pub mod lexer;
pub mod parser;
pub mod type_checker;

pub use codegen::{generate, CodegenError, GeneratedCode};
pub use type_checker::{
    check_currency_mixing, check_types, find_node_spec, NodeSpec, TypeError, TypedNodeDecl,
    TypedProject, BUILTIN_NODE_SPECS,
};

use std::fmt;

/// Aggregate error type for the full compile pipeline. Returned by
/// [`compile`] and [`compile_and_generate`]; each variant captures a
/// different stage's failure.
#[derive(Debug)]
pub enum CompileError {
    LexError(lexer::LexError),
    ParseError(parser::ParseError),
    TypeErrors(Vec<TypeError>),
    CodegenError(CodegenError),
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompileError::LexError(e) => write!(f, "{}", e),
            CompileError::ParseError(e) => write!(f, "{}", e),
            CompileError::TypeErrors(errors) => {
                writeln!(f, "{} type error(s):", errors.len())?;
                for e in errors {
                    writeln!(f, "  - {}", e)?;
                }
                Ok(())
            }
            CompileError::CodegenError(e) => write!(f, "codegen error: {}", e),
        }
    }
}

impl std::error::Error for CompileError {}

impl From<lexer::LexError> for CompileError {
    fn from(e: lexer::LexError) -> Self {
        CompileError::LexError(e)
    }
}

impl From<parser::ParseError> for CompileError {
    fn from(e: parser::ParseError) -> Self {
        CompileError::ParseError(e)
    }
}

impl From<CodegenError> for CompileError {
    fn from(e: CodegenError) -> Self {
        CompileError::CodegenError(e)
    }
}

/// A successful compile: the typed project plus any non-fatal warnings
/// (e.g. the I-1 currency-mixing warning). Warnings never fail compilation
/// — they surface to the caller alongside the result.
#[derive(Debug)]
pub struct CompileResult {
    pub project: TypedProject,
    pub warnings: Vec<TypeError>,
}

/// A successful compile-and-generate: the generated code plus warnings.
#[derive(Debug)]
pub struct GenerateResult {
    pub code: GeneratedCode,
    pub warnings: Vec<TypeError>,
}

/// End-to-end compile: lex → parse → type-check, plus the warning pass.
/// Returns the typed project (consumable by [`generate`]) and any warnings,
/// or the first failing stage's error(s). Type-check errors are collected —
/// a project with three independent mistakes returns all three.
pub fn compile(source: &str) -> Result<CompileResult, CompileError> {
    let tokens = lexer::lex(source)?;
    let project = parser::parse(tokens)?;
    // I-1 (currency mixing) is warning-level: computed from the parsed AST
    // before check_types consumes it, surfaced regardless of success.
    let warnings = check_currency_mixing(&project);
    let project = check_types(project).map_err(CompileError::TypeErrors)?;
    Ok(CompileResult { project, warnings })
}

/// Full pipeline: lex → parse → type-check → codegen. The output
/// `code.rust_source` is a Rust source string that, when compiled against
/// `warp-core` + `warp-catalog`, registers a Restate workflow
/// implementing the project. This is the Week-8-gate convenience.
pub fn compile_and_generate(source: &str) -> Result<GenerateResult, CompileError> {
    let CompileResult { project, warnings } = compile(source)?;
    let code = generate(&project).map_err(CompileError::CodegenError)?;
    Ok(GenerateResult { code, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLEAN: &str = r#"
        project "clean" {
            version = "1.0.0"
            tenant  = "t"
            CartAbandoned trigger {
                min_value: Currency(200, MAD)
                after:     Duration(30, minutes)
            }
        }
    "#;

    const MIXED_CURRENCY: &str = r#"
        project "mixed" {
            version = "1.0.0"
            tenant  = "t"
            CartAbandoned trigger {
                min_value: Currency(200, MAD)
                after:     Duration(30, minutes)
                cap:       Currency(50, EUR)
            }
        }
    "#;

    #[test]
    fn compile_result_includes_empty_warnings_when_clean() {
        let result = compile(CLEAN).expect("clean source compiles");
        assert!(result.warnings.is_empty());
        assert_eq!(result.project.nodes.len(), 1);
    }

    #[test]
    fn compile_result_includes_currency_warning_when_mixed() {
        let result = compile(MIXED_CURRENCY).expect("mixed currency still compiles (warning only)");
        assert!(
            result
                .warnings
                .iter()
                .any(|w| matches!(w, TypeError::CurrencyMixingWarning { .. })),
            "got {:?}",
            result.warnings
        );
    }
}
