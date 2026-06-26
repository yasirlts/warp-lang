/**
 * Tests for the adapter-registry mechanism: the validator accepts well-formed
 * manifests and rejects malformed ones with a clear, locatable error; the index
 * lists, filters, and looks up the manifests registered into it.
 */
import { describe, it, expect } from "vitest";
import {
  AdapterRegistry,
  validateManifest,
  assertValidManifest,
  KNOWN_ADAPTER_MANIFESTS,
  type AdapterManifest,
} from "../src/index.js";

const VALID: AdapterManifest = {
  name: "acme-shop",
  platform: "acme",
  conformance: "self-reported",
  capabilities: [{ direction: "inbound", entity: "Commitment", via: "fromAcmeOrder" }],
};

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const r = validateManifest(VALID);
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.manifest.name).toBe("acme-shop");
  });

  it("accepts every shipped known-adapter manifest", () => {
    for (const m of KNOWN_ADAPTER_MANIFESTS) {
      expect(validateManifest(m).valid).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    const r = validateManifest(42);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.issues[0]?.message).toMatch(/must be an object/);
  });

  it("rejects a missing name with a clear, located issue", () => {
    const { name, ...noName } = VALID;
    const r = validateManifest(noName);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const issue = r.issues.find((i) => i.path === "/name");
      expect(issue?.message).toMatch(/name is required/);
    }
  });

  it("rejects a malformed name", () => {
    const r = validateManifest({ ...VALID, name: "Acme Shop!" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.issues.some((i) => i.path === "/name")).toBe(true);
  });

  it("rejects an unknown conformance status", () => {
    const r = validateManifest({ ...VALID, conformance: "totally-trusted" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const issue = r.issues.find((i) => i.path === "/conformance");
      expect(issue?.message).toMatch(/unverified.*self-reported.*verified/);
    }
  });

  it("rejects empty capabilities", () => {
    const r = validateManifest({ ...VALID, capabilities: [] });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.issues.some((i) => i.path === "/capabilities")).toBe(true);
  });

  it("rejects a capability with a bad direction, pointing at the exact element", () => {
    const r = validateManifest({
      ...VALID,
      capabilities: [{ direction: "sideways", entity: "Commitment", via: "x" }],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const issue = r.issues.find((i) => i.path === "/capabilities/0/direction");
      expect(issue?.message).toMatch(/inbound.*outbound/);
    }
  });

  it("collects multiple issues at once", () => {
    const r = validateManifest({ platform: "", conformance: "nope", capabilities: "x" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("assertValidManifest", () => {
  it("throws with a readable message listing the issues", () => {
    expect(() => assertValidManifest({ name: "x" })).toThrowError(/invalid adapter manifest/);
  });

  it("returns the manifest when valid", () => {
    expect(assertValidManifest(VALID).name).toBe("acme-shop");
  });
});

describe("AdapterRegistry (local index)", () => {
  it("registers and lists adapters by name", () => {
    const reg = new AdapterRegistry();
    for (const m of KNOWN_ADAPTER_MANIFESTS) reg.register(m);
    expect(reg.size).toBe(4);
    expect(reg.list().map((m) => m.name)).toEqual(["amazon", "paypal", "shopify", "stripe"]);
  });

  it("refuses to register a malformed manifest", () => {
    const reg = new AdapterRegistry();
    expect(() => reg.register({ name: "broken" })).toThrowError(/invalid adapter manifest/);
    expect(reg.size).toBe(0);
  });

  it("refuses to register a duplicate name, but replace overwrites", () => {
    const reg = new AdapterRegistry();
    reg.register(VALID);
    expect(() => reg.register(VALID)).toThrowError(/already in the index/);
    reg.replace({ ...VALID, conformance: "verified" });
    expect(reg.get("acme-shop")?.conformance).toBe("verified");
    expect(reg.size).toBe(1);
  });

  it("looks up, filters by platform, and filters by conformance", () => {
    const reg = new AdapterRegistry();
    for (const m of KNOWN_ADAPTER_MANIFESTS) reg.register(m);
    expect(reg.get("stripe")?.platform).toBe("stripe");
    expect(reg.listByPlatform("amazon").map((m) => m.name)).toEqual(["amazon"]);
    expect(reg.listByConformance("unverified").length).toBe(4);
    expect(reg.listByConformance("verified").length).toBe(0);
  });

  it("unregisters", () => {
    const reg = new AdapterRegistry();
    reg.register(VALID);
    expect(reg.unregister("acme-shop")).toBe(true);
    expect(reg.has("acme-shop")).toBe(false);
  });
});
