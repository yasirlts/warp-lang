import { describe, expect, it } from "vitest";
import { convert, InvalidRateError, type Money } from "../src/index.js";

const thousandMad: Money = { amount: 1000, currency: "MAD" };

describe("convert rate guard", () => {
  it("converts at a valid positive rate", () => {
    const eur = convert(thousandMad, "EUR", 0.092);
    expect(eur).toEqual({ amount: 92, currency: "EUR" });
  });

  it("rejects a zero rate", () => {
    expect(() => convert(thousandMad, "EUR", 0)).toThrow(InvalidRateError);
  });

  it("rejects a negative rate", () => {
    expect(() => convert(thousandMad, "EUR", -0.092)).toThrow(InvalidRateError);
  });

  it("rejects NaN", () => {
    expect(() => convert(thousandMad, "EUR", Number.NaN)).toThrow(InvalidRateError);
  });

  it("rejects Infinity", () => {
    expect(() => convert(thousandMad, "EUR", Number.POSITIVE_INFINITY)).toThrow(InvalidRateError);
  });

  it("does not mutate amount on a valid conversion", () => {
    convert(thousandMad, "EUR", 0.092);
    expect(thousandMad).toEqual({ amount: 1000, currency: "MAD" });
  });
});
