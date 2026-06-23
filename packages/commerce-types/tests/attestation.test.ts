import { describe, expect, it } from "vitest";

import { newCommitment, newFulfillment, partyId } from "../src/primitives.js";
import {
  canonicalize,
  generateAttestationKeyPair,
  signFulfillment,
  verifyFulfillment,
  importSignerPublicKey,
} from "../src/attestation.js";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

function aFulfillment() {
  const commitment = newCommitment(buyer, seller, { offered: [], requested: [] });
  return newFulfillment(commitment.id);
}

describe("fulfillment attestation", () => {
  it("sign then verify succeeds", async () => {
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    expect(signed.signer).toBe(keys.signer);
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);
    await expect(verifyFulfillment(signed)).resolves.toBe(true);
  });

  it("the envelope carries the fulfillment unchanged (no schema field added)", async () => {
    const fulfillment = aFulfillment();
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(fulfillment, keys);

    expect(signed.fulfillment).toEqual(fulfillment);
    // signature/signer live on the envelope, not inside the fulfillment object.
    expect("signature" in signed.fulfillment).toBe(false);
    expect("signer" in signed.fulfillment).toBe(false);
  });

  it("a tampered fulfillment fails verification", async () => {
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    const tampered = {
      ...signed,
      fulfillment: { ...signed.fulfillment, state: { type: "Completed" as const } },
    };
    await expect(verifyFulfillment(tampered)).resolves.toBe(false);
  });

  it("a tampered nested field fails verification", async () => {
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    const tampered = {
      ...signed,
      fulfillment: { ...signed.fulfillment, commitment: "commitment:forged" as never },
    };
    await expect(verifyFulfillment(tampered)).resolves.toBe(false);
  });

  it("a wrong signer fails verification", async () => {
    const keys = await generateAttestationKeyPair();
    const other = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    const wrongSigner = { ...signed, signer: other.signer };
    await expect(verifyFulfillment(wrongSigner)).resolves.toBe(false);
  });

  it("a tampered signature fails verification", async () => {
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    // Flip the first character of the base64url signature to a different one.
    // (The leading char encodes whole signature bytes, so the change is real.)
    const first = signed.signature.slice(0, 1);
    const flipped = first === "A" ? "B" : "A";
    const badSig = { ...signed, signature: flipped + signed.signature.slice(1) };
    await expect(verifyFulfillment(badSig)).resolves.toBe(false);
  });

  it("a malformed signer returns false rather than throwing", async () => {
    const keys = await generateAttestationKeyPair();
    const signed = await signFulfillment(aFulfillment(), keys);

    const malformed = { ...signed, signer: "not-a-valid-key" };
    await expect(verifyFulfillment(malformed)).resolves.toBe(false);
  });

  it("re-signing by a different key verifies under that key (authenticity is per key)", async () => {
    const fulfillment = aFulfillment();
    const other = await generateAttestationKeyPair();
    const signed = await signFulfillment(fulfillment, other);
    await expect(verifyFulfillment(signed)).resolves.toBe(true);
  });

  it("canonicalize is order-independent for object keys", () => {
    const a = { z: 1, a: { d: 4, c: 3 }, m: [1, 2] };
    const b = { a: { c: 3, d: 4 }, m: [1, 2], z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("canonicalize preserves array order (order is meaningful)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("the exported signer round-trips as an importable public key", async () => {
    const keys = await generateAttestationKeyPair();
    const imported = await importSignerPublicKey(keys.signer);
    expect(imported.type).toBe("public");
  });
});
