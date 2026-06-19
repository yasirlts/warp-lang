# The Warp Commerce Language Manifesto

## Commerce has no language.

SAP calls it a `SalesOrder`. Shopify calls it an `Order`. Odoo calls
it a `sale.order`. Magento calls it `Sales::Order`. These are the
same concept — a customer has agreed to buy something — expressed in
four incompatible vocabularies.

This is not a new problem. Every company that has tried to connect
two commerce systems has paid for it. Integration projects between
ERP systems and e-commerce platforms cost between $40,000 and
$150,000 per pair. With N systems, you need N-squared integrations.
The cost grows with the square of your ambition.

Every retailer who has ever stood up a "single customer view" project
has met this problem. Every CTO who has tried to introduce a new
marketing automation tool has met this problem. Every developer who
has touched a `cart.abandoned` webhook and a `sale.order.cancelled`
event in the same week has met this problem.

We accepted the cost because there was no alternative.

---

## The inflection point.

AI agents are about to mediate trillions of dollars of commerce.
McKinsey estimates $3-5 trillion by 2030. Google has launched a
Universal Commerce Protocol for how AI agents complete purchases.
Anthropic has launched the Model Context Protocol for how AI systems
call tools.

Both solve the connectivity layer. Neither solves the vocabulary
layer.

An AI agent that can call any tool and complete any purchase still
has to *understand* what a cart abandonment means. What currency
safety requires. What a vendor confirmation state machine looks like.
What a WhatsApp opt-in flag implies for outbound channel selection.
What `discount_code: null` with `confidence: 1.0` means as a business
decision.

Every AI system that touches commerce today invents its own
vocabulary from scratch. ChatGPT plugins re-derive what an Order is.
Custom GPTs re-derive what a Customer is. Every new commerce agent
ships with its own data model and the same N-squared problem in a
new form.

This is the data problem before SQL. Every database had its own
query language. You could not move a query from one system to
another. The concepts were not portable. The cost of integrating two
databases was a project. The cost of integrating N databases was
N-squared projects. SQL ended that.

---

## The claim.

Warp is the SQL moment for commerce logic.

Not a workflow tool. Not an automation platform. A **typed vocabulary
for commerce** — where `CartAbandonedEvent` means the same thing
whether it comes from Shopify, SAP, WooCommerce, Odoo, or Agora.
Where `Currency(MAD)` cannot be accidentally added to `Currency(EUR)`
without an explicit conversion. Where a compiler catches commerce
mistakes before they reach a live customer.

When a Shopify developer and an SAP developer both write Warp types,
they are writing in the same language. The adapter translates the
platform's native format into Warp's vocabulary once. After that,
every AI system, every workflow, every automation speaks commerce
natively.

The compiler is the user's ally. Wiring a raw `String` where a
`PhoneNumber` is expected fails at compile time with a message that
explains the fix in commerce language ("expected a phone — try
`PhoneNumber::parse(...)`"), not Rust trait-bound noise. A mixed-
currency arithmetic operation surfaces as "Cannot operate on mixed
currencies: MAD and EUR. Use convert_to() first." A workflow that
doesn't compile cannot be installed against a tenant. The merchant
never sees a broken workflow.

This is a stricter contract than commerce systems usually offer.
That strictness is the point. The cost of a wrong type at runtime —
a discount code rendered as `null` in a customer's WhatsApp message,
an order amount confused between currencies on a live checkout — is
not a developer-experience problem. It is a trust-with-the-customer
problem. Warp refuses to allow it.

---

## The proof.

Warp is not a proposal. It is a working system.

Day 90: a merchant typed a workflow description in Arabic. The AI
builder generated a typed `.warp` source. The compiler validated it.
The runtime ran it against a real store in 34 milliseconds. Billing
was logged. The execution survived a server restart and resumed
exactly where it stopped. End-to-end evidence is in
the Day 90 gate —
timestamped, with journal IDs.

Five platform adapters translate real commerce events into Warp's
typed vocabulary: Agora, Shopify, WooCommerce, OpenCart, Odoo. The
same workflow runs on all five. A cart abandonment on a Shopify store
fires the same `CartRecoveryFull` chain as a cart abandonment on
Agora. The adapter underneath is invisible.

The compiler catches whole classes of mistakes before they reach
customers. A reference to a nonexistent node fails at compile time with a
Levenshtein-suggested correction; un-converted currency mixing blocks
compilation (declaring an explicit conversion is the sanctioned escape); and
capacity, temporal-order, identity, state-monotonicity (lifecycle-stage), and
commitment-tree violations are rejected. And the model's audit layer checks every
invariant at runtime — proven equivalent across four language bindings by
the conformance cross-check — so a defined class of commerce mistakes is
caught against a formal contract instead of surfacing in production.

Live ACP integration on 2026-05-28: the typed `CustomerProfile` round-
tripped through the ACP intelligence layer for customer 487 against
`acp.aimer.ma`. Phone normalized to E.164, language `"french"` parsed
into `Language::French`, channel `"whatsapp"` parsed into
`Channel::WhatsApp`, `name: null` handled gracefully. The end-to-end
chain ran with six durable Restate sub-invocations, all completed
exactly once, billing recorded six units. The integration revealed a
bug we hadn't yet fixed — the offer-branch was sending discount
templates when ACP recommended none. The type system surfaced the
bug; the v0.2 spec encodes the fix as a normative invariant.

---

## The invitation.

Warp is open.

The type specification is at [the type spec](../spec/TYPE_SPEC.md).
The adapter guide is at [the compatibility guide](../spec/COMPATIBLE_GUIDE.md). Both live in
the open repository [yasirlts/warp-lang](https://github.com/yasirlts/warp-lang).

If you build a Warp adapter for your platform, your merchants get
access to every Warp workflow, every AI builder integration, every
automation that any other Warp-compatible platform has. The
vocabulary is the network effect. Five adapters is enough to prove
the concept. Fifty adapters is what makes Warp the dialect commerce
speaks.

The five-rule adapter contract is small enough to print on a card:
namespace your identifiers, validate `Currency` at the boundary,
validate `PhoneNumber` at the boundary, carry `tenant_id` on every
event, use ISO 8601 timestamps. The five reference implementations
in the repository are 200-400 lines of Rust each. The next adapter
takes 3-5 senior-engineer days.

The type specification reaches v1.0 when two independent
implementations exist. One is Lamar Tech's. **We are looking for the
second.**

If you maintain a commerce platform and you want your merchants to
have access to a typed, compiled, AI-native automation layer — read
the [guide](../spec/COMPATIBLE_GUIDE.md). Build the adapter. Become Warp-compatible.

---

## Commerce has no language. We are building one.

— Lamar Tech, May 2026.
