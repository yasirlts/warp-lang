// Five-minute quickstart: from install to a caught bug with order().
//
//   npm install @warp-lang/commerce-types
//   node order-quickstart.mjs
//
import { order } from "@warp-lang/commerce-types";

// 1) Build a valid order in a few lines: buyer, seller, a priced item, paid + fulfilled.
const built = order()
  .from("buyer_1")
  .to("seller_1")
  .item({ sku: "TSHIRT-RED-M", price: { amount: 200, currency: "MAD" } })
  .paid()
  .fulfilled()
  .build();

if (built.ok) {
  // The headline check: audit the history-complete order. An empty list is clean.
  const violations = built.value.audit();
  console.log("valid order — violations:", violations.length); // 0
}

// 2) Now a buggy order: two currencies in one order. The builder surfaces it
//    as a Result, with an actionable message — it does not coerce a broken object.
const mixed = order()
  .from("buyer_1")
  .to("seller_1")
  .value({ amount: 200, currency: "MAD" })
  .value({ amount: 30, currency: "EUR" })
  .build();

if (mixed.ok === false) {
  console.log("caught:", mixed.error);
}
