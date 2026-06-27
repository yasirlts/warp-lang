// A toy adopter's money-state operations. The adopter DECLARES these as money
// sinks in warp-coverage.config.json. (This file is a fixture; it is parsed by
// the audit, never executed.)

/** A ledger post — mutates commerce/money state. */
export function postLedger(entry: { amount: number }): void {
  void entry;
}

/** A payment-SDK charge — moves money. */
export function chargeCard(charge: { amount: number }): void {
  void charge;
}
