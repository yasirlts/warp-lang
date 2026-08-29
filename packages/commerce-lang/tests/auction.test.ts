/**
 * The market-making rung — authoring the model's auction constructs.
 *
 * The claim under test is the same one the lifecycle form makes, extended to the
 * market-making half of the model: an `auction` block authored in `.warp` lowers
 * to the EXACT structures the model already defines — an `AuctionProcess`
 * auxiliary record, the `Tendered` commitment state of each open offer, and the
 * `UnderAuction` value state the subject carries while the auction is open — and
 * the result is indistinguishable from writing those structures by hand, as judged
 * by the model's own guard and temporal verifier.
 *
 * Nothing here introduces a model concept. Every structure asserted below is one
 * the schema already defines; the language only writes it down.
 */
import { describe, expect, it } from "vitest";
import {
  guardAction,
  newCommitment,
  applyCommitmentPath,
  partyId,
  validTransitions,
  verifyLifecycle,
} from "@warp-lang/commerce-types";
import type {
  AuctionProcess,
  CommitmentState,
  PartyID,
  TransitionFn,
  ValueState,
  World,
} from "@warp-lang/commerce-types";
import { compile } from "../src/compile.js";
import { WarpCompileError, WarpSyntaxError } from "../src/errors.js";

/** The compiled table's plain-string fn, viewed as the model's branded TransitionFn. */
const asTransitionFn = (fn: (s: string) => string[]): TransitionFn => fn as unknown as TransitionFn;

const CLOSES = "2026-03-07T17:00:00.000Z";
const OPENS = "2026-03-01T09:00:00.000Z";

/** A spectrum auction: an English mechanism, two tenders, closed on the higher bid. */
const SPECTRUM = `
  auction "auction:spectrum-2026-a" {
    subject   "value:spectrum-block-a"
    seller    "party:regulator"
    opens_at  "${OPENS}"
    closes_at "${CLOSES}"

    mechanism English {
      reserve_price 1000000 MAD
      increment       50000 MAD
    }

    tender "commitment:bid-nortel" {
      offer     1050000 MAD
      closes_at "${CLOSES}"
    }

    tender "commitment:bid-atlas" {
      offer     1100000 MAD
      closes_at "${CLOSES}"
    }

    state Closed {
      reason        NormalClose
      winner        "commitment:bid-atlas"
      winning_price 1100000 MAD
    }
  }
`;

describe("auction — lowering to the model's AuctionProcess", () => {
  const auction = compile(SPECTRUM).auctions[0]!;

  it("compiles to exactly the hand-written AuctionProcess", () => {
    // The hand-written equivalent, typed as the model's own generated record. If
    // the authored form drifted from the schema shape, this would not typecheck.
    const handWritten: AuctionProcess = {
      id: "auction:spectrum-2026-a",
      subject: "value:spectrum-block-a" as AuctionProcess["subject"],
      seller: "party:regulator" as AuctionProcess["seller"],
      mechanism: {
        kind: "English",
        reserve_price: { amount: 1000000, currency: "MAD" },
        increment: { amount: 50000, currency: "MAD" },
      },
      tendered_commitments: [
        "commitment:bid-nortel",
        "commitment:bid-atlas",
      ] as AuctionProcess["tendered_commitments"],
      opens_at: OPENS,
      closes_at: CLOSES,
      state: {
        type: "Closed",
        winning_commitment: "commitment:bid-atlas" as AuctionProcess["tendered_commitments"][number],
        winning_price: { amount: 1100000, currency: "MAD" },
        reason: "NormalClose",
      },
    };
    expect(auction.process).toEqual(handWritten);
  });

  it("tendered_commitments are the declared tenders, in source order", () => {
    expect(auction.process.tendered_commitments).toEqual([
      "commitment:bid-nortel",
      "commitment:bid-atlas",
    ]);
  });

  it("each tender lowers to the model's Tendered commitment state", () => {
    const handWritten: CommitmentState = {
      type: "Tendered",
      offer_amount: 1050000,
      offer_currency: "MAD",
      closes_at: CLOSES,
    };
    expect(auction.tenders[0]!.commitment).toBe("commitment:bid-nortel");
    expect(auction.tenders[0]!.state).toEqual(handWritten);
  });

  it("a superseded tender carries the model's optional superseded_by link", () => {
    // An English auction supersedes an earlier bid with a higher one; the model's
    // Tendered state records that with `superseded_by`.
    const superseded = compile(`
      auction "auction:s" {
        subject "v" seller "s" opens_at "${OPENS}" closes_at "${CLOSES}"
        mechanism English
        tender "commitment:bid-1" {
          offer 100 MAD
          closes_at "${CLOSES}"
          superseded_by "commitment:bid-2"
        }
        tender "commitment:bid-2" { offer 200 MAD closes_at "${CLOSES}" }
        state Open
      }
    `).auctions[0]!;
    expect(superseded.tenders[0]!.state).toEqual({
      type: "Tendered",
      offer_amount: 100,
      offer_currency: "MAD",
      closes_at: CLOSES,
      superseded_by: "commitment:bid-2",
    });
    // Omitted on a tender that was not superseded — the field is optional, and the
    // compiler does not invent one.
    expect(superseded.tenders[1]!.state).not.toHaveProperty("superseded_by");
  });

  it("a closed auction puts no value under auction", () => {
    expect(auction.subjectState).toBeNull();
  });

  it("an OPEN auction lowers its subject to the model's UnderAuction value state", () => {
    const open = compile(`
      auction "auction:open-1" {
        subject   "value:lot-1"
        seller    "party:house"
        opens_at  "${OPENS}"
        closes_at "${CLOSES}"
        mechanism Vickrey { reserve_price 500 EUR }
        state Open
      }
    `).auctions[0]!;
    const handWritten: ValueState = {
      type: "UnderAuction",
      auction_process_id: "auction:open-1",
      closes_at: CLOSES,
    };
    expect(open.subjectState).toEqual(handWritten);
  });
});

describe("auction — every mechanism the model defines", () => {
  const mech = (body: string) =>
    compile(`
      auction "a" {
        subject "v" seller "s" opens_at "${OPENS}" closes_at "${CLOSES}"
        ${body}
        state Scheduled
      }
    `).auctions[0]!.process.mechanism;

  it("English, with both optional prices omitted", () => {
    expect(mech("mechanism English")).toEqual({ kind: "English" });
  });

  it("Dutch", () => {
    expect(
      mech(`mechanism Dutch {
        start_price 900 EUR
        decrement    25 EUR
        interval_seconds 30
      }`),
    ).toEqual({
      kind: "Dutch",
      start_price: { amount: 900, currency: "EUR" },
      decrement: { amount: 25, currency: "EUR" },
      interval_seconds: 30,
    });
  });

  it("SealedBid", () => {
    expect(mech(`mechanism SealedBid { reveal_at "${CLOSES}" }`)).toEqual({
      kind: "SealedBid",
      reveal_at: CLOSES,
    });
  });

  it("Vickrey", () => {
    expect(mech("mechanism Vickrey { reserve_price 10 USD }")).toEqual({
      kind: "Vickrey",
      reserve_price: { amount: 10, currency: "USD" },
    });
  });

  it("ScoredSelection, with repeated weighted criteria", () => {
    expect(
      mech(`mechanism ScoredSelection {
        criterion "price"     0.6 100
        criterion "technical" 0.4 100
        minimum_threshold 70
        committee "party:eval-1", "party:eval-2"
        publication_required true
      }`),
    ).toEqual({
      kind: "ScoredSelection",
      criteria: [
        { name: "price", weight: 0.6, max_points: 100 },
        { name: "technical", weight: 0.4, max_points: 100 },
      ],
      minimum_threshold: 70,
      evaluation_committee: ["party:eval-1", "party:eval-2"],
      publication_required: true,
    });
  });
});

describe("round-trip — an authored tender is judged identically to a hand-written one", () => {
  const seller: PartyID = partyId("party:regulator");
  const authoredTender = compile(SPECTRUM).auctions[0]!.tenders[1]!;

  /** The same Tendered state, written by hand. */
  const handWrittenTender: CommitmentState = {
    type: "Tendered",
    offer_amount: 1100000,
    offer_currency: "MAD",
    closes_at: CLOSES,
  };

  /** A world holding one commitment already moved to `state`. */
  function worldIn(state: CommitmentState): World {
    const base = newCommitment(partyId("party:atlas"), seller);
    return {
      commitments: [applyCommitmentPath(base, state, seller)],
      fulfillments: [],
      parties: [],
    };
  }

  it("the authored Tendered state IS the hand-written one", () => {
    expect(authoredTender.state).toEqual(handWrittenTender);
  });

  it("a legal Tendered -> Accepted gets the same guard verdict either way", () => {
    const a = worldIn(authoredTender.state);
    const b = worldIn(handWrittenTender);
    const move = (w: World) =>
      guardAction(w, {
        commitment: w.commitments[0]!.id,
        to: { type: "Accepted" },
        actor: seller,
      });
    const ra = move(a);
    const rb = move(b);
    expect(ra.ok).toBe(true);
    expect(ra.ok).toBe(rb.ok);
  });

  it("an illegal Tendered -> Fulfilled is refused identically, with the same alternatives", () => {
    const a = worldIn(authoredTender.state);
    const b = worldIn(handWrittenTender);
    const move = (w: World) =>
      guardAction(w, {
        commitment: w.commitments[0]!.id,
        to: { type: "Fulfilled" },
        actor: seller,
      });
    const ra = move(a);
    const rb = move(b);
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    if (ra.ok === false && rb.ok === false) {
      expect(ra.violations.map((v) => v.rule)).toEqual(rb.violations.map((v) => v.rule));
      expect(ra.violations.some((v) => v.rule === "I-2")).toBe(true);
      // The model's own planning oracle: from Tendered you may only go Accepted
      // or Cancelled. The authored path gets the identical advice.
      expect(ra.alternatives).toEqual(rb.alternatives);
      expect(validTransitions({ type: "Tendered" } as CommitmentState).sort()).toEqual([
        "Accepted",
        "Cancelled",
      ]);
    }
  });
});

describe("round-trip — an authored market-making lifecycle verifies identically", () => {
  // The market-making path through the model: an offer is tendered, the auction
  // determines the counterparty, the winner is accepted and fulfilled.
  const MARKET = `
    lifecycle marketmaking {
      state Draft
      state Tendered
      state Accepted
      state PartiallyFulfilled
      state Fulfilled
      state Cancelled

      Draft              -> Tendered, Cancelled
      Tendered           -> Accepted, Cancelled
      Accepted           -> PartiallyFulfilled, Cancelled
      PartiallyFulfilled -> Fulfilled, Cancelled
    }
  `;

  it("every authored edge is one the model itself permits", () => {
    const lc = compile(MARKET).lifecycles[0]!;
    for (const s of lc.states) {
      const authored = lc.transitionFn(s);
      const model = validTransitions({ type: s } as CommitmentState);
      for (const target of authored) expect(model, `edge ${s} -> ${target}`).toContain(target);
    }
  });

  it("the temporal verifier finds it sound, exploring to a fixpoint", () => {
    const lc = compile(MARKET).lifecycles[0]!;
    const result = verifyLifecycle({ from: "Draft", transitions: asTransitionFn(lc.transitionFn) });
    expect(result.violations).toEqual([]);
    expect(result.verdict).toBe("fixpoint-sound");
  });

  it("an ILLEGAL tendered edge compiles but the verifier still catches it", () => {
    // Tendered -> Fulfilled skips the commitment: the model forbids it. Both
    // states are real, so the document is WELL-FORMED and compiles — and then the
    // model's own verifier rejects it with the counterexample path. The language
    // cannot smuggle an unsound market-making model past the invariants.
    const lc = compile(`
      lifecycle rigged {
        state Draft
        state Tendered
        state Fulfilled
        Draft    -> Tendered
        Tendered -> Fulfilled
      }
    `).lifecycles[0]!;
    const result = verifyLifecycle({ from: "Draft", transitions: asTransitionFn(lc.transitionFn) });
    expect(result.verdict).toBe("violation-found");
    const v = result.violations.find((x) => x.state === "Fulfilled");
    expect(v).toBeDefined();
    expect(v!.rule).toBe("I-2");
    expect(v!.path).toEqual(["Draft", "Tendered", "Fulfilled"]);
  });
});

describe("auction — well-formedness errors, each at a precise position", () => {
  /** Compile `src`, expecting a compile error whose message matches, at line:col. */
  function expectCompileErrorAt(src: string, line: number, column: number, match: RegExp): void {
    try {
      compile(src, { file: "t.warp" });
      throw new Error("expected a WarpCompileError but compilation succeeded");
    } catch (e) {
      expect(e).toBeInstanceOf(WarpCompileError);
      const err = e as WarpCompileError;
      expect(err.message).toMatch(match);
      expect(err.line).toBe(line);
      expect(err.column).toBe(column);
      expect(err.format()).toContain(`t.warp:${line}:${column}:`);
    }
  }

  const wrap = (body: string) =>
    `auction "a" {\n  subject "v"\n  seller "s"\n  opens_at "${OPENS}"\n  closes_at "${CLOSES}"\n${body}\n}`;

  it("an invented mechanism is rejected, naming the model's five", () => {
    // Line 6, column 13 — the mechanism name.
    expectCompileErrorAt(
      wrap("  mechanism Blind\n  state Open"),
      6,
      13,
      /Unknown auction mechanism 'Blind'.*English.*ScoredSelection/s,
    );
  });

  it("a mechanism missing a required field is rejected", () => {
    expectCompileErrorAt(
      wrap("  mechanism Dutch { start_price 10 EUR }\n  state Open"),
      6,
      13,
      /missing required field 'decrement'/,
    );
  });

  it("a field belonging to a different mechanism is rejected", () => {
    // `increment` is English-only; on a Vickrey it is not a legal field.
    expectCompileErrorAt(
      wrap("  mechanism Vickrey { increment 5 EUR }\n  state Open"),
      6,
      23,
      /Field 'increment' does not belong to the 'Vickrey' mechanism/,
    );
  });

  it("an invented close reason is rejected, naming the model's five", () => {
    expectCompileErrorAt(
      wrap("  mechanism English\n  state Closed { reason Whenever }"),
      7,
      25,
      /Unknown auction close reason 'Whenever'.*NormalClose/s,
    );
  });

  it("a winner that is not one of the auction's tenders is rejected", () => {
    expectCompileErrorAt(
      wrap('  mechanism English\n  state Closed { reason NormalClose winner "commitment:ghost" }'),
      7,
      37,
      /'commitment:ghost' is not a tender of auction 'a'/,
    );
  });

  it("a duplicate tender id is rejected, citing identity permanence", () => {
    expectCompileErrorAt(
      wrap(
        `  tender "commitment:x" { offer 1 EUR closes_at "${CLOSES}" }\n` +
          `  tender "commitment:x" { offer 2 EUR closes_at "${CLOSES}" }\n` +
          "  mechanism English\n  state Open",
      ),
      7,
      10,
      /Duplicate tender 'commitment:x'.*Identity Permanence/s,
    );
  });

  it("an auction with no mechanism is rejected", () => {
    expectCompileErrorAt(wrap("  state Open"), 1, 1, /missing its 'mechanism'/);
  });

  it("an auction with no state is rejected", () => {
    expectCompileErrorAt(wrap("  mechanism English"), 1, 1, /missing its 'state'/);
  });

  it("a non-Closed state carrying fields is rejected", () => {
    expectCompileErrorAt(
      wrap("  mechanism English\n  state Open { reason NormalClose }"),
      7,
      16,
      /Auction state 'Open' takes no fields/,
    );
  });

  it("a duplicate auction id is rejected", () => {
    const src = `${wrap("  mechanism English\n  state Open")}\n${wrap(
      "  mechanism English\n  state Open",
    )}`;
    // The second declaration's id string begins on line 9.
    expectCompileErrorAt(src, 9, 9, /Duplicate auction 'a'/);
  });
});

describe("auction — syntax errors point at the exact character", () => {
  function expectSyntaxErrorAt(src: string, line: number, column: number, expected: string): void {
    try {
      compile(src, { file: "t.warp" });
      throw new Error("expected a WarpSyntaxError but parsing succeeded");
    } catch (e) {
      expect(e).toBeInstanceOf(WarpSyntaxError);
      const err = e as WarpSyntaxError;
      expect(err.line).toBe(line);
      expect(err.column).toBe(column);
      expect(err.expected).toBe(expected);
    }
  }

  it("an unknown auction field names the legal ones", () => {
    expectSyntaxErrorAt(
      'auction "a" {\n  colour "red"\n}',
      2,
      3,
      "one of 'subject', 'seller', 'opens_at', or 'closes_at', 'mechanism', 'tender', or 'state'",
    );
  });

  it("a money amount with no currency is caught at the missing code", () => {
    expectSyntaxErrorAt(
      'auction "a" {\n  mechanism English { reserve_price 100 }\n}',
      2,
      41,
      "a currency code after the amount in 'reserve_price' (like 'MAD')",
    );
  });

  it("an auction id must be a quoted string, not a bare identifier", () => {
    expectSyntaxErrorAt(
      "auction spectrum {}",
      1,
      9,
      "an auction id after 'auction' (a quoted string)",
    );
  });

  it("a number glued to an identifier is a typo, not two tokens", () => {
    expectSyntaxErrorAt(
      'auction "a" {\n  mechanism Dutch { interval_seconds 30s }\n}',
      2,
      38,
      "whitespace after a number",
    );
  });

  it("a boolean field rejects a non-boolean", () => {
    expectSyntaxErrorAt(
      'auction "a" {\n  mechanism ScoredSelection { publication_required yes }\n}',
      2,
      52,
      "'true' or 'false'",
    );
  });
});
