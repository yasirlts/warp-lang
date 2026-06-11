//! POC: cart recovery workflow.
//!
//! Demonstrates two of the Restate primitives Warp depends on:
//!   1. Durable execution — the workflow survives `kill -9` mid-sleep
//!      and resumes from exactly where it stopped.
//!   2. Durable sleep — `ctx.sleep` holds no thread and no connection;
//!      Restate journals the deadline and resumes the workflow at the
//!      right wall-clock time even if the warp-server process restarts.
//!
//! Test delays are intentionally short (5s + 10s) instead of the
//! production targets (30min + 24h) so the recovery test completes
//! quickly. Production code would parameterize these durations.

use restate_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CartAbandonedEvent {
    pub customer_id: String,
    pub cart_value_mad: u64,
    pub phone: String,
}

#[restate_sdk::workflow]
pub trait CartRecovery {
    async fn run(input: Json<CartAbandonedEvent>) -> Result<String, HandlerError>;
}

pub struct CartRecoveryImpl;

impl CartRecovery for CartRecoveryImpl {
    async fn run(
        &self,
        ctx: WorkflowContext<'_>,
        Json(event): Json<CartAbandonedEvent>,
    ) -> Result<String, HandlerError> {
        tracing::info!(
            customer = %event.customer_id,
            cart_value_mad = event.cart_value_mad,
            "cart_recovery: workflow start"
        );

        // Step 1 — first-touch delay. 5s here; 30min in production.
        // This is the kill -9 recovery point: if warp-server dies during
        // this sleep, Restate replays the workflow on restart and continues
        // the wait from the original deadline.
        tracing::info!("cart_recovery: sleeping 5s before first-touch");
        ctx.sleep(Duration::from_secs(5)).await?;

        // Step 2 — first-touch notification (journaled side effect).
        let phone1 = event.phone.clone();
        let val1 = event.cart_value_mad;
        ctx.run(|| async move {
            tracing::info!(
                "[FIRST-TOUCH] would send WhatsApp to {} re: MAD {} cart",
                phone1,
                val1
            );
            Ok::<(), HandlerError>(())
        })
        .name("first_touch_send")
        .await?;

        // Step 3 — follow-up delay. 10s here; 24h in production.
        tracing::info!("cart_recovery: sleeping 10s before follow-up");
        ctx.sleep(Duration::from_secs(10)).await?;

        // Step 4 — follow-up notification.
        let phone2 = event.phone.clone();
        ctx.run(|| async move {
            tracing::info!(
                "[FOLLOW-UP] would send WhatsApp to {} re: discount offer",
                phone2
            );
            Ok::<(), HandlerError>(())
        })
        .name("follow_up_send")
        .await?;

        tracing::info!(customer = %event.customer_id, "cart_recovery: workflow done");
        Ok(format!("recovery_done:{}", event.customer_id))
    }
}
