//! Emit the Rust binding's verdict for every conformance fixture, as JSON.
//!
//! Runs each fixture through the CANONICAL Rust binding (schema-generated types
//! in `warp_commerce_types::generated` + the hand-written runtime ported from
//! `conformance/runner/run.mjs`). Used by `conformance/tooling/crosscheck.mjs`
//! to prove TS, Python, and Rust agree.
//!
//! Verdict shape per fixture (identical to crosscheck-ts.mjs / crosscheck-python.py):
//!   { id, kind, runnable, verdict: "accept"|"reject"|null, rules:[], steps:[bool], note }
//! `runnable=false` means this binding exposes no behavioral API for the fixture
//! (state-catalog fixtures are structural — covered by the runner + JSON Schema).
//!
//! Paths are resolved relative to the current working directory, which is the
//! repo root when invoked by crosscheck.mjs. The verdict JSON array (manifest
//! order, one per fixture) is written to STDOUT only.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use warp_commerce_types::generated::types::{Commitment, Fulfillment, MoneyComponent, Party};
use warp_commerce_types::runtime::{
    audit_scene, breakdown_is_valid, currency_decimals, is_valid_transition,
};

fn conformance_dir() -> PathBuf {
    // Allow an explicit override; otherwise resolve `conformance/` against CWD
    // (the repo root when crosscheck.mjs invokes this binary).
    if let Ok(dir) = std::env::var("WARP_CONFORMANCE_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from("conformance")
}

fn load_json(root: &Path, rel: &str) -> Value {
    let path = root.join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

/// Round half-to-even? No — run.mjs uses Math.round (half away from zero for
/// positive, toward +inf for .5). Replicate JS Math.round semantics.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn process_fixture(kind: &str, fx: &Value) -> Value {
    let payload = &fx["payload"];

    match kind {
        "scene" => {
            // deserialize the typed inputs; any failure → runnable=false
            let parties: Result<Vec<Party>, _> = serde_json::from_value(payload["parties"].clone());
            let commitments: Result<Vec<Commitment>, _> =
                serde_json::from_value(payload["commitments"].clone());
            let fulfillments: Result<Vec<Fulfillment>, _> =
                serde_json::from_value(payload["fulfillments"].clone());
            match (parties, commitments, fulfillments) {
                (Ok(parties), Ok(commitments), Ok(fulfillments)) => {
                    let rules = audit_scene(&commitments, &fulfillments, &parties);
                    let verdict = if rules.is_empty() { "accept" } else { "reject" };
                    json!({ "verdict": verdict, "rules": rules })
                }
                _ => json!({ "error": "scene deserialization failed" }),
            }
        }
        "transition-sequence" => {
            let primitive = payload["primitive"].as_str().unwrap_or("");
            let mut cur = payload["initial"].clone();
            let mut steps: Vec<bool> = Vec::new();
            if let Some(arr) = payload["steps"].as_array() {
                for step in arr {
                    let to = &step["to"];
                    let valid = is_valid_transition(primitive, &cur, to);
                    steps.push(valid);
                    if valid {
                        cur = to.clone();
                    }
                }
            }
            json!({ "verdict": "accept", "steps": steps })
        }
        "money-roundtrip" => {
            let mut ok_all = true;
            if let Some(cases) = payload["cases"].as_array() {
                for c in cases {
                    let currency = c["currency"].as_str().unwrap_or("");
                    let minor = c["minor_amount"].as_f64().unwrap_or(f64::NAN);
                    let decimal_amount = c["decimal_amount"].as_f64().unwrap_or(f64::NAN);
                    let f = 10f64.powi(currency_decimals(currency));
                    let decimal = minor / f;
                    if decimal != decimal_amount || js_round(decimal * f) != minor {
                        ok_all = false;
                    }
                }
            }
            json!({ "verdict": if ok_all { "accept" } else { "reject" }, "rules": [] })
        }
        "money-breakdown" => {
            let total_currency = payload["total"]["currency"].as_str().unwrap_or("");
            let total_amount = payload["total"]["amount"].as_f64().unwrap_or(f64::NAN);
            let components: Result<Vec<MoneyComponent>, _> =
                serde_json::from_value(payload["components"].clone());
            match components {
                Ok(components) => {
                    if breakdown_is_valid(total_currency, total_amount, &components) {
                        json!({ "verdict": "accept", "rules": [] })
                    } else {
                        json!({ "verdict": "reject", "rules": ["money_breakdown_sum"] })
                    }
                }
                Err(e) => json!({ "error": format!("{e}") }),
            }
        }
        "state-catalog" => json!({ "state_catalog": true }),
        other => json!({ "error": format!("unknown kind {other}") }),
    }
}

fn main() {
    let root = conformance_dir();
    let manifest = load_json(&root, "manifest.json");
    let fixtures = manifest["fixtures"].as_array().expect("manifest.fixtures");

    let mut out: Vec<Value> = Vec::new();
    for entry in fixtures {
        let id = entry["id"].as_str().unwrap_or("").to_string();
        let kind = entry["kind"].as_str().unwrap_or("").to_string();
        let path = entry["path"].as_str().unwrap_or("");

        let mut record = json!({
            "id": id,
            "kind": kind,
            "runnable": true,
            "verdict": Value::Null,
            "rules": [],
            "steps": [],
            "note": "",
        });

        // Load + process; mirror the TS/Python try/catch by catching panics.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let fx = load_json(&root, path);
            process_fixture(&kind, &fx)
        }));

        match result {
            Ok(processed) => {
                if processed.get("state_catalog").is_some() {
                    record["runnable"] = json!(false);
                    record["note"] = json!("structural only — covered by runner + JSON Schema");
                } else if let Some(err) = processed.get("error").and_then(|e| e.as_str()) {
                    record["runnable"] = json!(false);
                    record["note"] = json!(format!("Rust raised: {err}"));
                } else {
                    if let Some(v) = processed.get("verdict") {
                        record["verdict"] = v.clone();
                    }
                    if let Some(r) = processed.get("rules") {
                        record["rules"] = r.clone();
                    }
                    if let Some(s) = processed.get("steps") {
                        record["steps"] = s.clone();
                    }
                }
            }
            Err(e) => {
                let msg = e
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| e.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "panic".to_string());
                record["runnable"] = json!(false);
                record["note"] = json!(format!("Rust raised: {msg}"));
            }
        }

        out.push(record);
    }

    // Pretty JSON to stdout only (parseable by crosscheck.mjs).
    println!(
        "{}",
        serde_json::to_string_pretty(&Value::Array(out)).unwrap()
    );
}
