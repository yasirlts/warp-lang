// Fulfillment attestation: sign a fulfillment, then verify it. A detached Ed25519
// signature over a canonical serialization of the fulfillment, carried alongside
// it as an envelope { fulfillment, signature, signer } — a toolkit-layer wrapper,
// not a schema field.
//
//   npm install @warp-lang/commerce-types
//   node attestation.mjs
//
// What this proves: the exact fulfillment shown was signed by the holder of the
// signer's private key, and has not been altered since. What it does NOT prove:
// that the signer key belongs to any particular party (that is PKI, out of scope);
// it is also not a zero-knowledge proof — the fulfillment is fully disclosed.
import {
  newCommitment,
  newFulfillment,
  partyId,
  generateAttestationKeyPair,
  signFulfillment,
  verifyFulfillment,
} from "@warp-lang/commerce-types";

const buyer = partyId("buyer_1");
const seller = partyId("seller_1");

// A fulfillment of some commitment.
const commitment = newCommitment(buyer, seller, { offered: [], requested: [] });
const fulfillment = newFulfillment(commitment.id);

// 1) The seller signs the fulfillment with their key.
const sellerKeys = await generateAttestationKeyPair();
const signed = await signFulfillment(fulfillment, sellerKeys);
console.log(`signed by ${signed.signer.slice(0, 12)}… → verifies: ${await verifyFulfillment(signed)}`);

// 2) A tampered fulfillment fails — changing any content changes the canonical
//    bytes, so the original signature no longer matches.
const tampered = {
  ...signed,
  fulfillment: { ...signed.fulfillment, state: { type: "Completed" } },
};
console.log(`tampered (state flipped to Completed) → verifies: ${await verifyFulfillment(tampered)}`);

// 3) A wrong signer fails — substituting a different public key does not verify a
//    signature made by the seller's key.
const otherKeys = await generateAttestationKeyPair();
const wrongSigner = { ...signed, signer: otherKeys.signer };
console.log(`wrong signer (different public key) → verifies: ${await verifyFulfillment(wrongSigner)}`);

// 4) Re-signed by the other key over the SAME fulfillment → verifies under that
//    key. Authenticity is per signer key, not a claim about who that signer is.
const reSigned = await signFulfillment(fulfillment, otherKeys);
console.log(`re-signed by ${reSigned.signer.slice(0, 12)}… → verifies: ${await verifyFulfillment(reSigned)}`);
