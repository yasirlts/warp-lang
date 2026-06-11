//! `end_to_end_compile_and_generate` — the Week 8 gate proof.
//!
//! Takes the full ADR-0007 cart-recovery `.warp` source, runs it
//! through `compile_and_generate`, writes the generated Rust to a
//! temp crate that depends on the live `warp-core` + `warp-catalog`
//! via path deps, and shells out to `cargo check`. A green exit
//! means the entire pipeline (lex → parse → type-check → codegen)
//! produced source that the Rust compiler accepts.
//!
//! `#[ignore]` because:
//!   * It shells out to `cargo`, which is slow (~10–30s on a warm
//!     build, longer on a cold one).
//!   * It writes to `std::env::temp_dir()`; CI sandboxes vary in
//!     what they allow there.
//!   * It pins absolute paths into the workspace via `path = "…"`
//!     deps, which is fine on a dev laptop and fine when the test
//!     runs from inside the workspace, but isn't portable to
//!     pre-built artifacts.
//!
//! Run it manually as the Week-8-gate proof:
//!
//! ```bash
//! cargo test -p warp-core --test codegen_e2e -- --ignored --nocapture
//! ```

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use warp_core::dsl::compile_and_generate;

/// The canonical cart-recovery `.warp` source from ADR-0007. Same
/// shape the in-tree unit and live-Restate tests exercise — keeping
/// this file aligned with that example means the gate proves the
/// pipeline handles the project we ship demos against.
const CART_RECOVERY_SRC: &str = r#"
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

/// Compose the Cargo.toml for the scratch crate. The path deps land
/// against the live workspace; the version pins on the rest of the
/// dependencies mirror the workspace `Cargo.toml`.
fn scratch_cargo_toml(workspace_root: &str) -> String {
    format!(
        r#"[package]
name = "warp_codegen_e2e_scratch"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "src/lib.rs"

[dependencies]
warp-core    = {{ path = "{root}/crates/warp-core" }}
warp-catalog = {{ path = "{root}/crates/warp-catalog" }}
restate-sdk  = "0.10"
serde        = {{ version = "1", features = ["derive"] }}
serde_json   = "1"
rust_decimal = {{ version = "1", features = ["serde-with-str"] }}

[workspace]
"#,
        root = workspace_root
    )
}

/// Find the Warp workspace root from the test's runtime context.
/// `CARGO_MANIFEST_DIR` is the crate dir (`…/crates/warp-core`); the
/// workspace root is two `..`s up.
fn workspace_root() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is always set during cargo test");
    let mut p = PathBuf::from(manifest_dir);
    p.pop(); // crates/
    p.pop(); // workspace root
    p
}

fn unique_scratch_dir() -> PathBuf {
    let id = uuid::Uuid::new_v4();
    let mut p = std::env::temp_dir();
    p.push(format!("warp_codegen_e2e_{}", id));
    p
}

#[test]
#[ignore = "shells out to `cargo check`; run with --ignored as the Week 8 gate"]
fn end_to_end_compile_and_generate() {
    // 1. Run the pipeline.
    let generated = compile_and_generate(CART_RECOVERY_SRC)
        .expect("full pipeline must succeed")
        .code;
    assert_eq!(generated.workflow_name, "cart_recovery");
    assert_eq!(generated.node_count, 6);
    assert!(!generated.rust_source.is_empty());
    println!(
        "codegen produced {} bytes of Rust source for {} nodes",
        generated.rust_source.len(),
        generated.node_count
    );

    // 2. Lay out a scratch crate.
    let scratch = unique_scratch_dir();
    fs::create_dir_all(scratch.join("src")).expect("create scratch dir");
    let cargo_toml_path = scratch.join("Cargo.toml");
    let lib_rs_path = scratch.join("src").join("lib.rs");

    let root = workspace_root();
    let root_str = root.to_string_lossy();
    fs::write(&cargo_toml_path, scratch_cargo_toml(&root_str)).expect("write Cargo.toml");
    fs::write(&lib_rs_path, &generated.rust_source).expect("write lib.rs");

    println!("scratch crate at: {}", scratch.display());
    println!("generated lib.rs head:");
    for line in generated.rust_source.lines().take(20) {
        println!("    {}", line);
    }

    // 3. cargo check.
    let output = Command::new("cargo")
        .arg("check")
        .arg("--manifest-path")
        .arg(&cargo_toml_path)
        .output()
        .expect("spawn cargo check");

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Don't auto-delete on failure — leave the scratch dir for
        // post-mortem inspection.
        panic!(
            "cargo check failed (exit {:?})\n--- stderr ---\n{}\n--- stdout ---\n{}\n\nscratch dir kept at: {}",
            output.status.code(),
            stderr,
            stdout,
            scratch.display()
        );
    }

    // 4. Clean up only on success (so failures stay debuggable).
    let _ = fs::remove_dir_all(&scratch);
    println!("Week 8 gate: cargo check PASSED on generated source");
}
