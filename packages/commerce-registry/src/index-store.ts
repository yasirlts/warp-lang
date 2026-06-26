/**
 * The local INDEX.
 *
 * An in-memory collection of registered adapter manifests, keyed by name. It is
 * "local" in the literal sense: it lives in the process that created it, persists
 * nothing, and talks to no network. This is the mechanism a tool or a CI step
 * uses to gather the adapter manifests it knows about and ask questions of them
 * (list all, filter by platform, look one up). It is not a hosted registry.
 *
 * Registration validates the manifest first (via the validator), so an index can
 * only ever hold well-formed manifests. A malformed manifest is rejected at the
 * door with the validator's issues, never silently stored.
 */

import type { AdapterManifest, ConformanceStatus } from "./manifest.js";
import { formatIssues, validateManifest } from "./validate.js";

export class AdapterRegistry {
  private readonly byName = new Map<string, AdapterManifest>();

  /**
   * Validate and register a manifest. Throws if the manifest is malformed (with
   * the validator's issues) or if its name is already registered — re-registering
   * a name is a mistake, not an update; use `replace` to deliberately overwrite.
   */
  register(candidate: unknown): AdapterManifest {
    const result = validateManifest(candidate);
    if (!result.valid) {
      throw new Error(`cannot register: invalid adapter manifest:\n${formatIssues(result.issues)}`);
    }
    const { manifest } = result;
    if (this.byName.has(manifest.name)) {
      throw new Error(`cannot register: an adapter named "${manifest.name}" is already in the index`);
    }
    this.byName.set(manifest.name, manifest);
    return manifest;
  }

  /** Validate and register, overwriting any existing manifest of the same name. */
  replace(candidate: unknown): AdapterManifest {
    const result = validateManifest(candidate);
    if (!result.valid) {
      throw new Error(`cannot register: invalid adapter manifest:\n${formatIssues(result.issues)}`);
    }
    this.byName.set(result.manifest.name, result.manifest);
    return result.manifest;
  }

  /** True if an adapter of this name is registered. */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** The manifest registered under `name`, or undefined. */
  get(name: string): AdapterManifest | undefined {
    return this.byName.get(name);
  }

  /** Remove an adapter from the index. Returns true if one was removed. */
  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  /** Number of adapters currently in the index. */
  get size(): number {
    return this.byName.size;
  }

  /** All registered manifests, ordered by name for stable listing. */
  list(): AdapterManifest[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** All registered manifests targeting `platform`, ordered by name. */
  listByPlatform(platform: string): AdapterManifest[] {
    return this.list().filter((m) => m.platform === platform);
  }

  /** All registered manifests at a given conformance status, ordered by name. */
  listByConformance(status: ConformanceStatus): AdapterManifest[] {
    return this.list().filter((m) => m.conformance === status);
  }
}
