# The `.warp` Syntax (v0.1)

A reference for the textual form merchants and the AI builder write
workflows in. This is the canonical serialization the compiler consumes.

## File extension

`.warp` — one file declares exactly one `project`.

## Project structure

A `.warp` file is a `project` block: a header (`version`, `tenant`) followed
by a sequence of typed node declarations that form the workflow graph.

```warp
project "cart_recovery" {
  version = "1.0.0"
  tenant  = "tenant_aimer"

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
    params:   { discount_code: offer.discount_code }
  }
}
```

The structure mirrors what merchants see on the canvas:

- The `project` block is the workflow.
- Each declaration is one node.
- `<NodeType> <instance_name>` identifies every node — the **node type**
  (PascalCase) tells the compiler which catalog entry to type-check against;
  the **instance name** (snake_case) is what later declarations dot-reference
  to read that node's output.

Declaration order is for **readability**. The compiler reconstructs the
dependency graph from the `instance.field` references inside node bodies, not
from top-to-bottom position.

## Tokens

| Token        | Form                                          | Example                          |
|--------------|-----------------------------------------------|----------------------------------|
| `KEYWORD`    | `project`, `version`, `tenant`                | `project`                        |
| `NODE_TYPE`  | PascalCase identifier (a catalog node)        | `CartAbandoned`, `WhatsAppSend`  |
| `IDENTIFIER` | `snake_case` identifier                       | `trigger`, `first_touch`         |
| `STRING`     | Double-quoted, supports `\"` and `\\`         | `"cart_reminder"`                |
| `CURRENCY`   | `Currency(<amount>, <CODE>)`                  | `Currency(200, MAD)`             |
| `DURATION`   | `Duration(<amount>, <unit>)`                  | `Duration(30, minutes)`          |
| `REFERENCE`  | `<identifier>.<field>`                        | `profile.phone`                  |
| `OBJECT`     | `{ key: value, … }`                           | `{ discount_code: offer.code }`  |
| punctuation  | `{` `}` `:` `,` `=`                           |                                  |

Node types vs. instance names are distinguished **by case**: PascalCase is
reserved for node types, snake_case for instance names and field accesses.

### Commerce types are first-class

`Currency(200, MAD)` and `Duration(30, minutes)` are single lexical tokens,
not function calls — commerce types are *syntax*, not a standard-library
prelude. The compiler lifts the amount + unit/code directly onto the typed
config value.

- **Duration units (v0.1):** `seconds`, `minutes`, `hours`, `days`.
- **Currency codes (v0.1):** three-letter uppercase; `MAD`, `EUR`, `USD` are
  validated by the type checker.

## Comments

Line comments start with `//` and run to end of line. Block comments are
reserved syntax (not in v0.1).

```warp
// fire only on carts worth recovering
CartAbandoned trigger {
  min_value: Currency(200, MAD)   // MAD is a real type, not a number
  after:     Duration(30, minutes)
}
```

## What the compiler enforces

Beyond syntax, the compiler checks:

1. **Node types exist** — every PascalCase node must be in the catalog.
2. **References resolve** — every `instance.field` must name a node declared
   earlier (or the keyword `trigger`, which refers to the first trigger node).
3. **Required inputs are present** — each node declares the config keys it
   requires.
4. **Commerce-model invariants** — currency conservation, capacity
   verification, temporal order, identity permanence, and commitment-tree
   consistency. See the [Commerce Model](../spec/COMMERCE_MODEL.md) and the
   [Getting Started guide](GETTING_STARTED.md#what-the-compiler-checks).

## Error philosophy

Every error names the token found, what was expected, and the 1-based line —
because the compiler is the author's ally, not an obstacle. For example:

```
Line 9: WhatsAppSend 'send' is missing required input 'to'.
```

There is no "error near `<unknown>`". If the lexer emits a token, the parser
knows what it is and where it is.

## Out of scope for v0.1

Loops, conditionals, and string interpolation are not in v0.1. When a workflow
needs branching, compose it from multiple nodes. The grammar is intentionally
narrow — small enough to ship and prove, wide enough to express real commerce
recovery, post-purchase, and campaign workflows.
