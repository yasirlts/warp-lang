//! Hand-written behavioral runtime — a faithful port of the normative
//! conformance runner `conformance/runner/run.mjs`.
//!
//! Everything here mirrors run.mjs line-by-line: `currencyDecimals`,
//! `moneyEquals`, `isValidTransition` (incl. the documented fulfillment
//! `Failed -> Planned` recoverable-only special case), the six-invariant
//! `auditScene`, and the `breakdownRule` / `money_breakdown_sum` rule. It
//! consumes the schema-generated types in [`crate::generated`].

use crate::generated::transitions::{
    COMMITMENT_TRANSITIONS, FULFILLMENT_TRANSITIONS, INTENT_TRANSITIONS,
};
use crate::generated::types::{
    Commitment, CommitmentState, FulfillmentState, MoneyComponent, Party, Value, ValueForm,
};
use std::collections::BTreeSet;

// ===========================================================================
// Money precision — ZERO_DECIMAL / THREE_DECIMAL sets exactly as run.mjs.
// ===========================================================================

const ZERO_DECIMAL: &[&str] = &[
    "JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "XPF", "BIF", "DJF", "GNF", "KMF", "MGA",
    "PYG", "RWF", "UGX", "VUV",
];
const THREE_DECIMAL: &[&str] = &["TND", "BHD", "KWD", "OMR", "JOD"];

/// `currencyDecimals(c)` — minor-unit decimal places for a currency code.
pub fn currency_decimals(c: &str) -> i32 {
    let u = c.to_uppercase();
    if ZERO_DECIMAL.contains(&u.as_str()) {
        0
    } else if THREE_DECIMAL.contains(&u.as_str()) {
        3
    } else {
        2
    }
}

/// `moneyEquals(a, b, c)` — equality within half a minor unit of `c`.
pub fn money_equals(a: f64, b: f64, c: &str) -> bool {
    (a - b).abs() < 0.5 * 10f64.powi(-currency_decimals(c))
}

// ===========================================================================
// Transition validity — operates on the raw `{type, ...}` JSON state objects,
// exactly like run.mjs `isValidTransition(primitive, from, to)`.
// ===========================================================================

fn state_type(state: &serde_json::Value) -> Option<&str> {
    state.get("type").and_then(|t| t.as_str())
}

fn table_for(primitive: &str) -> Option<&'static [(&'static str, &'static [&'static str])]> {
    match primitive {
        "commitment" => Some(COMMITMENT_TRANSITIONS),
        "intent" => Some(INTENT_TRANSITIONS),
        "fulfillment" => Some(FULFILLMENT_TRANSITIONS),
        _ => None,
    }
}

/// `isValidTransition(primitive, from, to)` — table lookup plus the documented
/// fulfillment `Failed -> Planned` special case (valid iff `recoverable === true`).
pub fn is_valid_transition(
    primitive: &str,
    from: &serde_json::Value,
    to: &serde_json::Value,
) -> bool {
    let from_type = state_type(from);
    let to_type = state_type(to);

    if primitive == "fulfillment" && from_type == Some("Failed") {
        // Failed -> Planned is valid iff recoverable === true; every other
        // Failed -> X is rejected.
        return if to_type == Some("Planned") {
            from.get("recoverable").and_then(|r| r.as_bool()) == Some(true)
        } else {
            false
        };
    }

    let (Some(table), Some(ft), Some(tt)) = (table_for(primitive), from_type, to_type) else {
        return false;
    };
    table
        .iter()
        .find(|(k, _)| *k == ft)
        .map(|(_, tos)| tos.contains(&tt))
        .unwrap_or(false)
}

// ===========================================================================
// Money helpers for the scene audit — `moneyOf` / `sumMoney`.
// ===========================================================================

struct SumResult {
    total: Option<(f64, String)>, // (amount, currency)
    mixed: bool,
}

/// `moneyOf(v)` — the Money in a Value whose form is `Money`, else None.
fn money_of(v: &Value) -> Option<(f64, &str)> {
    match v.form.as_ref() {
        ValueForm::Money(mv) => Some((mv.money.amount, mv.money.currency.as_str())),
        _ => None,
    }
}

/// `sumMoney(values)` — first-currency total + a mixed flag.
fn sum_money(values: &[&Value]) -> SumResult {
    let mut currencies: Vec<String> = Vec::new();
    let mut amount = 0.0;
    for v in values {
        if let Some((amt, cur)) = money_of(v) {
            if !currencies.iter().any(|c| c == cur) {
                currencies.push(cur.to_string());
            }
            amount += amt;
        }
    }
    if currencies.is_empty() {
        SumResult {
            total: None,
            mixed: false,
        }
    } else {
        SumResult {
            total: Some((amount, currencies[0].clone())),
            mixed: currencies.len() > 1,
        }
    }
}

/// The single committed Money of a commitment (sum of `subject.requested`), as
/// `(amount, currency)`. Composes `sum_money` so the toolkit reuses the auditor's
/// money summation rather than re-deriving it.
pub(crate) fn committed_money(c: &Commitment) -> Option<(f64, String)> {
    let requested: Vec<&Value> = c.subject.requested.iter().collect();
    sum_money(&requested).total
}

// ===========================================================================
// Commitment-state helpers — discriminant string and history reads.
// ===========================================================================

/// The discriminant string of a CommitmentState (`&str`), matching run.mjs's
/// reliance on `state.type`.
pub(crate) fn commitment_state_type(s: &CommitmentState) -> &'static str {
    match s {
        CommitmentState::Draft => "Draft",
        CommitmentState::Proposed => "Proposed",
        CommitmentState::Tendered { .. } => "Tendered",
        CommitmentState::Accepted => "Accepted",
        CommitmentState::Modified { .. } => "Modified",
        CommitmentState::PartiallyFulfilled { .. } => "PartiallyFulfilled",
        CommitmentState::Active => "Active",
        CommitmentState::Fulfilled => "Fulfilled",
        CommitmentState::Cancelled { .. } => "Cancelled",
        CommitmentState::Disputed { .. } => "Disputed",
        CommitmentState::Refunded { .. } => "Refunded",
    }
}

fn fulfillment_state_type(s: &FulfillmentState) -> &'static str {
    match s {
        FulfillmentState::Planned => "Planned",
        FulfillmentState::InProgress => "InProgress",
        FulfillmentState::Completed => "Completed",
        FulfillmentState::Failed { .. } => "Failed",
        FulfillmentState::Reversed { .. } => "Reversed",
    }
}

const ACCEPTED_OR_LATER: &[&str] = &[
    "Accepted",
    "Active",
    "Modified",
    "PartiallyFulfilled",
    "Fulfilled",
    "Disputed",
    "Refunded",
];

/// `reachedAccepted(c)` — current state is Accepted-or-later, OR any history
/// transition landed on Accepted.
fn reached_accepted(c: &Commitment) -> bool {
    if ACCEPTED_OR_LATER.contains(&commitment_state_type(&c.state)) {
        return true;
    }
    c.history
        .iter()
        .any(|h| commitment_state_type(&h.to) == "Accepted")
}

/// `acceptedAt(c)` — the `at` timestamp of the first transition to Accepted.
fn accepted_at(c: &Commitment) -> Option<&str> {
    c.history
        .iter()
        .find(|h| commitment_state_type(&h.to) == "Accepted")
        .map(|h| h.at.as_str())
}

// ISO-8601 timestamp parsing: run.mjs uses Date.parse, which yields epoch ms.
// The fixtures only ever COMPARE two timestamps (monotonicity / ordering), so a
// lexicographic compare of the canonical ISO strings is order-equivalent for
// the well-formed timestamps the fixtures use. We compare via Date.parse-style
// millis to stay faithful where possible, falling back to string compare.
fn parse_epoch_ms(s: &str) -> Option<i64> {
    // Expect ISO-8601 like 2026-01-02T12:00:00Z or with offset / fractional sec.
    // Minimal parser sufficient for ordering: parse the date-time fields.
    let bytes = s.as_bytes();
    if s.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b' ')
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    // Days from a fixed epoch (proleptic Gregorian) — only relative order matters.
    let a = (14 - month) / 12;
    let y = year + 4800 - a;
    let m = month + 12 * a - 3;
    let jdn = day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    Some(((jdn * 24 + hour) * 60 + min) * 60_000 + sec * 1000)
}

/// Compare two timestamps the way `Date.parse(a) < Date.parse(b)` does.
fn timestamp_lt(a: &str, b: &str) -> bool {
    match (parse_epoch_ms(a), parse_epoch_ms(b)) {
        (Some(x), Some(y)) => x < y,
        _ => a < b, // fallback: lexicographic, order-equivalent for ISO strings
    }
}

// ===========================================================================
// The six-invariant scene audit — port of run.mjs `auditScene`.
// ===========================================================================

/// `auditScene(scene)` — returns the sorted, unique invariant ids violated
/// ("I-1".."I-6"). An empty result means the scene is accepted.
pub fn audit_scene(
    commitments: &[Commitment],
    fulfillments: &[crate::generated::types::Fulfillment],
    parties: &[Party],
) -> Vec<String> {
    let mut out: Vec<&'static str> = Vec::new();

    // capacity by party id
    let cap_by_party: std::collections::HashMap<&str, &crate::generated::types::PartyCapacity> =
        parties
            .iter()
            .map(|p| (p.id.as_str(), &p.capacity))
            .collect();
    // commitments by id
    let by_id: std::collections::HashMap<&str, &Commitment> =
        commitments.iter().map(|c| (c.id.as_str(), c)).collect();

    // I-1 no_currency_mixing
    for c in commitments {
        let mut all: Vec<&Value> = Vec::new();
        all.extend(c.subject.offered.iter());
        all.extend(c.subject.requested.iter());
        if sum_money(&all).mixed {
            out.push("I-1");
        }
    }
    // I-1 amount conservation (over-refund): a Refunded commitment's refund
    // amount must not exceed the original committed amount, in the same currency
    // (same-currency only; a cross-currency refund is a separate concern).
    for c in commitments {
        if let CommitmentState::Refunded { amount: refund, .. } = &c.state {
            let requested: Vec<&Value> = c.subject.requested.iter().collect();
            if let Some((orig_amt, orig_cur)) = sum_money(&requested).total {
                if refund.currency == orig_cur
                    && refund.amount > orig_amt
                    && !money_equals(refund.amount, orig_amt, &refund.currency)
                {
                    out.push("I-1");
                }
            }
        }
    }

    for c in commitments {
        // I-2 commitment transition table + timestamp monotonicity
        for h in &c.history {
            let from = serde_json::json!({ "type": commitment_state_type(&h.from) });
            let to = serde_json::json!({ "type": commitment_state_type(&h.to) });
            if !is_valid_transition("commitment", &from, &to) {
                out.push("I-2");
            }
        }
        for i in 1..c.history.len() {
            if timestamp_lt(&c.history[i].at, &c.history[i - 1].at) {
                out.push("I-2");
            }
        }

        // I-3 capacity before Accepted
        if let Some(cap) = cap_by_party.get(c.parties.initiator.as_str()) {
            if reached_accepted(c) && !cap.can_buy {
                out.push("I-3");
            }
        }

        // I-4 fulfillment after accepted
        let acc = accepted_at(c);
        for f in fulfillments.iter().filter(|x| x.commitment == c.id) {
            let st = fulfillment_state_type(&f.state);
            let executed = st == "InProgress" || st == "Completed";
            if executed && acc.is_none() {
                out.push("I-4");
            } else if let (Some(started), Some(acc_at)) = (&f.started_at, acc) {
                if timestamp_lt(started, acc_at) {
                    out.push("I-4");
                }
            }
        }

        // I-6 tree sum
        if !c.children.is_empty() {
            let kids: Vec<&Commitment> = c
                .children
                .iter()
                .filter_map(|id| by_id.get(id.as_str()).copied())
                .collect();
            if !kids.is_empty() {
                let requested: Vec<&Value> = c.subject.requested.iter().collect();
                let parent_sum = sum_money(&requested);
                if let Some((parent_amt, parent_cur)) = parent_sum.total {
                    let mut child_amt = 0.0;
                    let mut currencies: BTreeSet<String> = BTreeSet::new();
                    currencies.insert(parent_cur.clone());
                    for k in &kids {
                        let kreq: Vec<&Value> = k.subject.requested.iter().collect();
                        if let Some((amt, cur)) = sum_money(&kreq).total {
                            currencies.insert(cur);
                            child_amt += amt;
                        }
                    }
                    // I-6 fires on either a mixed-currency tree or a child sum
                    // that does not reconstitute the parent within tolerance
                    // (the two clauses of run.mjs collapse to one push).
                    if currencies.len() > 1 || !money_equals(child_amt, parent_amt, &parent_cur) {
                        out.push("I-6");
                    }
                }
            }
        }
    }

    // I-5 identity permanence (no duplicate ids across commitments/fulfillments/parties)
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut dup = false;
    for id in commitments
        .iter()
        .map(|c| c.id.as_str())
        .chain(fulfillments.iter().map(|f| f.id.as_str()))
        .chain(parties.iter().map(|p| p.id.as_str()))
    {
        if !seen.insert(id) {
            dup = true;
        }
    }
    if dup {
        out.push("I-5");
    }

    // sorted unique (run.mjs returns insertion-unique; the crosscheck sorts).
    let unique: BTreeSet<&str> = out.into_iter().collect();
    unique.into_iter().map(|s| s.to_string()).collect()
}

// ===========================================================================
// money_breakdown_sum — port of run.mjs `breakdownRule`.
// ===========================================================================

/// `breakdownRule(b)` — returns true if the breakdown is VALID (single currency
/// across all components and the total, and components sum to the total within
/// `moneyEquals` tolerance). A false return is the `money_breakdown_sum`
/// violation (the structural expression of Invariant 1).
pub fn breakdown_is_valid(
    total_currency: &str,
    total_amount: f64,
    components: &[MoneyComponent],
) -> bool {
    for c in components {
        if c.amount.currency != total_currency {
            return false;
        }
    }
    let sum: f64 = components.iter().map(|c| c.amount.amount).sum();
    money_equals(sum, total_amount, total_currency)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn currency_decimals_matches_runner_sets() {
        assert_eq!(currency_decimals("MAD"), 2);
        assert_eq!(currency_decimals("usd"), 2); // case-insensitive
        assert_eq!(currency_decimals("JPY"), 0); // zero-decimal
        assert_eq!(currency_decimals("TND"), 3); // three-decimal
        assert_eq!(currency_decimals("PTS"), 2); // open / custom defaults to 2
    }

    #[test]
    fn money_equals_within_half_minor_unit() {
        // 0.1 + 0.2 != 0.3 in IEEE754, but equal within MAD tolerance.
        assert!(money_equals(0.1 + 0.2, 0.3, "MAD"));
        assert!(!money_equals(1.0, 2.0, "MAD"));
    }

    #[test]
    fn fulfillment_failed_to_planned_is_recoverable_only() {
        let recoverable = json!({ "type": "Failed", "recoverable": true });
        let nonrecoverable = json!({ "type": "Failed", "recoverable": false });
        let planned = json!({ "type": "Planned" });
        let in_progress = json!({ "type": "InProgress" });
        assert!(is_valid_transition("fulfillment", &recoverable, &planned));
        assert!(!is_valid_transition(
            "fulfillment",
            &nonrecoverable,
            &planned
        ));
        // Failed -> anything-but-Planned is always rejected.
        assert!(!is_valid_transition(
            "fulfillment",
            &recoverable,
            &in_progress
        ));
    }

    #[test]
    fn commitment_table_rejects_backward() {
        let accepted = json!({ "type": "Accepted" });
        let proposed = json!({ "type": "Proposed" });
        let cancelled = json!({ "type": "Cancelled" });
        assert!(is_valid_transition("commitment", &accepted, &cancelled));
        assert!(!is_valid_transition("commitment", &accepted, &proposed)); // no backward edge
    }

    #[test]
    fn breakdown_sum_rule() {
        use crate::generated::types::Money;
        let comp = |amt: f64, cur: &str| MoneyComponent {
            kind: crate::generated::types::MoneyComponentKind::Base,
            amount: Money {
                amount: amt,
                currency: cur.to_string(),
            },
            label: None,
            tax_rate: None,
            jurisdiction: None,
        };
        // 80 + 16 + 10 - 6 == 100, single currency → valid.
        assert!(breakdown_is_valid(
            "MAD",
            100.0,
            &[
                comp(80.0, "MAD"),
                comp(16.0, "MAD"),
                comp(10.0, "MAD"),
                comp(-6.0, "MAD")
            ]
        ));
        // mixed currency → invalid.
        assert!(!breakdown_is_valid("MAD", 100.0, &[comp(100.0, "EUR")]));
        // sum mismatch → invalid.
        assert!(!breakdown_is_valid("MAD", 100.0, &[comp(50.0, "MAD")]));
    }
}
