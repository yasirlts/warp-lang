//! warp-generated — Warp's compiled-workflow shell crate.
//!
//! Phase 3 ships this as a **stable shell**: the file-based
//! workflow-registration loop in `warp-server::workflow_registry`
//! writes generated Rust source into `crates/warp-generated/generated/`
//! (sibling to `src/`) but does NOT yet pull those files into the
//! crate's compilation graph. That wiring — a `build.rs` that
//! invokes `include_str!`-style file collection plus a Restate
//! discovery hook — lands in Phase 4 alongside hot-reload.
//!
//! For Phase 3 the contract is:
//!
//! 1. A merchant POSTs `.warp` source to
//!    `POST /api/v1/workflows/compile` on warp-server.
//! 2. The handler calls
//!    [`warp_core::dsl::compile_and_generate`](../warp_core/dsl/fn.compile_and_generate.html)
//!    and writes the resulting Rust source to
//!    `crates/warp-generated/generated/{workflow_name}.rs`.
//! 3. The operator runs `cargo build -p warp-generated` followed
//!    by a `warp-server` restart — at which point the generated
//!    workflow is registered with Restate alongside the hand-
//!    written catalog workflows.
//!
//! Hot-reload (no rebuild needed) is Phase 4 work; see
//! [docs/PHASE3.md](../../../docs/PHASE3.md) Stream D.

/// Count of generated workflows compiled into this crate. Phase 3
/// always returns 0 because `generated/` files aren't in the
/// compilation graph yet; Phase 4's `build.rs` will return the real
/// count.
///
/// Surfaced so the `GET /health` route can show
/// "generated workflows: {n}" alongside its existing node/template
/// counts — gives operators a quick liveness check that the
/// rebuild step ran.
pub const fn count() -> usize {
    0
}

/// Phase 3 placeholder type that downstream crates can name in
/// signatures. Stays empty in Phase 3; Phase 4 turns it into a real
/// enum of compiled-workflow Restate clients.
#[derive(Debug)]
pub struct Registered;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_returns_zero_in_phase_3() {
        // This is the load-bearing assertion that the Phase-3 shell
        // is intentionally empty. When Phase 4 lights up the
        // build.rs auto-include, this test gets replaced with one
        // that verifies the count tracks the file system.
        assert_eq!(count(), 0);
    }
}
