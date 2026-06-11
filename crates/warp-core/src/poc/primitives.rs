//! POC: small demos for the remaining Restate primitives Warp depends on.
//!
//!   - **Awakeable**: durable pause that blocks until external code resolves
//!     it. This is the substrate Warp will wrap as the `HumanQuery` /
//!     `ApprovalGate` primitive (a workflow can sleep for days waiting for
//!     an operator click).
//!   - **DurableFuturesUnordered**: parallel execution of N futures, with
//!     results processed as they complete. This is the substrate Warp will
//!     use to implement P-3 ("parallelism is a type property" — `List<T>`
//!     input to a `T` node fans out automatically).

use restate_sdk::prelude::*;
use std::time::Duration;

// ============================================================================
// Awakeable demo
// ============================================================================
//
// Invoke this handler. It will log an awakeable_id and then block.
// Resolve from the Restate CLI:
//   restate awakeable resolve <id> --json '"resolved-value"'
// or via HTTP:
//   curl -X POST http://localhost:8080/restate/awakeables/<id>/resolve \
//     -H 'Content-Type: application/json' -d '"resolved-value"'

#[restate_sdk::service]
pub trait AwakeableDemo {
    async fn run(prompt: String) -> Result<String, HandlerError>;
}

pub struct AwakeableDemoImpl;

impl AwakeableDemo for AwakeableDemoImpl {
    async fn run(&self, ctx: Context<'_>, prompt: String) -> Result<String, HandlerError> {
        let (key, future) = ctx.awakeable::<String>();
        tracing::info!(
            awakeable_id = %key,
            prompt = %prompt,
            "awakeable_demo: paused — resolve with the awakeable_id above"
        );
        let resolved = future.await?;
        tracing::info!(resolved = %resolved, "awakeable_demo: resumed");
        Ok(resolved)
    }
}

// ============================================================================
// Fan-out demo
// ============================================================================
//
// Mirrors the SDK's own `fan_out` example: three parallel sleeps with
// different durations, results collected as they complete. Returns the
// label of each completing future in completion order.

#[restate_sdk::service]
pub trait FanOutDemo {
    async fn run() -> Result<String, TerminalError>;
}

pub struct FanOutDemoImpl;

impl FanOutDemo for FanOutDemoImpl {
    async fn run(&self, ctx: Context<'_>) -> Result<String, TerminalError> {
        let labels = ["fast", "medium", "slow"];

        let mut futures = DurableFuturesUnordered::new();
        futures.push(ctx.sleep(Duration::from_secs(1)));
        futures.push(ctx.sleep(Duration::from_secs(2)));
        futures.push(ctx.sleep(Duration::from_secs(3)));

        let mut order: Vec<&'static str> = Vec::new();
        while let Some((index, result)) = futures.next().await? {
            result?;
            order.push(labels[index]);
            tracing::info!("fan_out_demo: {} completed (idx {})", labels[index], index);
        }

        Ok(format!("completed_order:{:?}", order))
    }
}
