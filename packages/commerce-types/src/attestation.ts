/**
 * Fulfillment attestation — a detached signature over a canonical serialization
 * of a {@link Fulfillment}, verifiable against the signer's public key.
 *
 * WHAT THIS PROVES
 *   Given a public key, verification confirms that the exact fulfillment object
 *   presented was signed by the holder of the matching private key, and that it
 *   has not been altered since signing (any change to the fulfillment's content
 *   changes its canonical bytes, so the signature no longer verifies).
 *
 * WHAT THIS DOES NOT PROVE
 *   - It does NOT establish that the public key belongs to any particular real
 *     party. Binding a key to an identity is PKI / key distribution, which is out
 *     of scope here. A verified signature tells you "this key signed this", not
 *     "this person signed this".
 *   - It is NOT a zero-knowledge proof. The full fulfillment is disclosed to the
 *     verifier; nothing is hidden.
 *   - It is a standard Ed25519 detached signature, not a novel scheme. Its
 *     security is exactly that of Ed25519 over the canonical bytes — no more.
 *
 * The attestation rides ALONGSIDE the fulfillment as a toolkit-layer envelope
 * ({@link SignedFulfillment} = `{ fulfillment, signature, signer }`); it is a
 * runtime wrapper, NOT a field inside the frozen Fulfillment schema — the same
 * pattern by which `idempotencyKey` rides on a proposed action (see guard.ts).
 *
 * Crypto is Node's built-in WebCrypto (`crypto.subtle`) with Ed25519. No crypto
 * is hand-rolled here; only the deterministic serialization of the object is.
 */

import type { Fulfillment } from "./primitives.js";

/**
 * Minimal WebCrypto surface, accessed through `globalThis` so this module needs
 * no DOM lib and no `@types/node` (the same `globalThis` idiom primitives.ts uses
 * for `crypto.randomUUID`). At runtime this is Node's built-in WebCrypto; these
 * local types describe only the calls we make, not the full Web Crypto API.
 */
interface SubtleLike {
  generateKey(
    algorithm: "Ed25519",
    extractable: boolean,
    usages: string[],
  ): Promise<{ privateKey: OpaqueKey; publicKey: OpaqueKey }>;
  exportKey(format: "raw", key: OpaqueKey): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: "Ed25519",
    extractable: boolean,
    usages: string[],
  ): Promise<OpaqueKey>;
  sign(algorithm: "Ed25519", key: OpaqueKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: "Ed25519",
    key: OpaqueKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

/** An opaque WebCrypto key handle (a `CryptoKey` at runtime). */
export interface OpaqueKey {
  readonly type: string;
}

function subtle(): SubtleLike {
  const c = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime; " +
        "fulfillment attestation requires a WebCrypto-capable runtime with Ed25519",
    );
  }
  return c.subtle;
}

/** Algorithm identifier for the WebCrypto calls. */
const ALG = "Ed25519" as const;

/**
 * A signer's public key, exported as raw bytes and base64url-encoded so the
 * envelope is plain JSON. This identifies WHICH key signed — it does not, on its
 * own, identify a real-world party (that is PKI, out of scope).
 */
export type SignerPublicKey = string;

/** A detached Ed25519 signature over the canonical fulfillment bytes, base64url. */
export type FulfillmentSignature = string;

/**
 * The attestation envelope: a fulfillment carried together with a detached
 * signature over it and the public key needed to verify that signature. This is
 * a toolkit-layer wrapper, not a schema field — the Fulfillment inside is
 * unchanged and still validates against the frozen schema.
 */
export interface SignedFulfillment {
  /** The fulfillment exactly as signed. Re-serialized canonically on verify. */
  fulfillment: Fulfillment;
  /** Detached Ed25519 signature over the canonical serialization, base64url. */
  signature: FulfillmentSignature;
  /** The signer's raw Ed25519 public key, base64url. Verifies `signature`. */
  signer: SignerPublicKey;
}

/** A generated Ed25519 keypair, with the public half pre-exported for the envelope. */
export interface AttestationKeyPair {
  /** Private key — keep secret; used only to {@link signFulfillment}. */
  privateKey: OpaqueKey;
  /** Public key handle, for direct {@link verifyFulfillment} use. */
  publicKey: OpaqueKey;
  /** Public key as base64url raw bytes — the value stored in the envelope's `signer`. */
  signer: SignerPublicKey;
}

// --- base64url (no padding) -------------------------------------------------

const g = globalThis as {
  btoa?: (s: string) => string;
  atob?: (s: string) => string;
};

function toBase64Url(bytes: Uint8Array): string {
  if (!g.btoa) throw new Error("btoa is unavailable in this runtime");
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return g.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  if (!g.atob) throw new Error("atob is unavailable in this runtime");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = g.atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- canonical serialization ------------------------------------------------

/**
 * Deterministically serialize a value to JSON: object keys are emitted in sorted
 * order at every depth, so two structurally-equal fulfillments always produce
 * byte-identical output regardless of property insertion order. Arrays keep their
 * order (order is meaningful, e.g. history). `undefined` properties are dropped,
 * matching `JSON.stringify`. This is the byte sequence that gets signed.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") throw new Error("cannot canonicalize a bigint");
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v === undefined ? null : v)).join(",")}]`;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`)
      .join(",");
    return `{${body}}`;
  }
  // undefined / function / symbol at the top level
  throw new Error(`cannot canonicalize value of type ${t}`);
}

/** Encode a string to UTF-8 bytes via the runtime's TextEncoder (globalThis idiom). */
function utf8(text: string): Uint8Array {
  const Enc = (globalThis as { TextEncoder?: new () => { encode(s: string): Uint8Array } })
    .TextEncoder;
  if (!Enc) throw new Error("TextEncoder is unavailable in this runtime");
  return new Enc().encode(text);
}

function canonicalBytes(fulfillment: Fulfillment): Uint8Array {
  return utf8(canonicalize(fulfillment));
}

// --- keys -------------------------------------------------------------------

/**
 * Generate a fresh Ed25519 keypair for signing fulfillments. The public key is
 * also returned base64url-encoded as `signer`, ready to drop into an envelope.
 */
export async function generateAttestationKeyPair(): Promise<AttestationKeyPair> {
  const s = subtle();
  const pair = await s.generateKey(ALG, true, ["sign", "verify"]);
  const raw = new Uint8Array(await s.exportKey("raw", pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    signer: toBase64Url(raw),
  };
}

/** Import a base64url raw Ed25519 public key (an envelope's `signer`) for verifying. */
export async function importSignerPublicKey(
  signer: SignerPublicKey,
): Promise<OpaqueKey> {
  return subtle().importKey("raw", fromBase64Url(signer), ALG, true, ["verify"]);
}

// --- sign / verify ----------------------------------------------------------

/**
 * Sign a fulfillment, producing the {@link SignedFulfillment} envelope. The
 * signature covers the canonical serialization of `fulfillment`; the returned
 * envelope embeds the fulfillment unchanged plus `signer` (the public key).
 */
export async function signFulfillment(
  fulfillment: Fulfillment,
  keys: Pick<AttestationKeyPair, "privateKey" | "signer">,
): Promise<SignedFulfillment> {
  const sig = new Uint8Array(
    await subtle().sign(ALG, keys.privateKey, canonicalBytes(fulfillment)),
  );
  return {
    fulfillment,
    signature: toBase64Url(sig),
    signer: keys.signer,
  };
}

/**
 * Verify an attestation envelope. Returns `true` only when the embedded
 * `signature` is a valid Ed25519 signature, by `signer`, over the canonical
 * serialization of the embedded `fulfillment`. Any tampering with the
 * fulfillment, the signature, or the signer key yields `false`. A malformed
 * signer/signature (e.g. wrong byte length) also yields `false` rather than
 * throwing — verification answers a boolean, it does not throw on bad input.
 *
 * NOTE: `true` means "this key signed this exact fulfillment". It does NOT assert
 * that the key belongs to any particular party — that is key distribution / PKI,
 * out of scope.
 */
export async function verifyFulfillment(
  signed: SignedFulfillment,
): Promise<boolean> {
  try {
    const key = await importSignerPublicKey(signed.signer);
    return await subtle().verify(
      ALG,
      key,
      fromBase64Url(signed.signature),
      canonicalBytes(signed.fulfillment),
    );
  } catch {
    return false;
  }
}
