/**
 * The manifest VALIDATOR.
 *
 * Checks a candidate value against the adapter-manifest format defined in
 * `manifest.ts`. It validates the FORMAT only — it does not load, import, or run
 * the adapter the manifest describes, and it makes no claim about whether the
 * adapter's mappings are correct. A passing manifest is well-formed; it is not
 * thereby verified.
 *
 * Every problem is reported with a JSON-Pointer-style path and a message that
 * says what was expected, so a malformed manifest fails with a clear, locatable
 * error rather than a thrown exception.
 */

import {
  isCapabilityDirection,
  isConformanceStatus,
  type AdapterManifest,
} from "./manifest.js";

/** One problem found while validating a manifest. */
export interface ValidationIssue {
  /** JSON-Pointer-style path to the offending field, e.g. "/capabilities/0/via". */
  path: string;
  /** What was wrong and what was expected. */
  message: string;
}

/** The outcome of validating a candidate manifest. */
export type ValidationResult =
  | { valid: true; manifest: AdapterManifest }
  | { valid: false; issues: ValidationIssue[] };

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a candidate against the adapter-manifest format. Returns a discriminated
 * result; never throws on malformed input. Collects all issues so a caller sees
 * everything wrong at once, not just the first problem.
 */
export function validateManifest(candidate: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(candidate)) {
    return { valid: false, issues: [{ path: "", message: "manifest must be an object" }] };
  }

  // name
  const name = candidate.name;
  if (typeof name !== "string" || name.length === 0) {
    issues.push({ path: "/name", message: "name is required and must be a non-empty string" });
  } else if (!NAME_RE.test(name)) {
    issues.push({
      path: "/name",
      message: `name "${name}" must be lowercase letters, digits, and single hyphens (e.g. "shopify" or "my-adapter")`,
    });
  }

  // description (optional)
  if (candidate.description !== undefined && typeof candidate.description !== "string") {
    issues.push({ path: "/description", message: "description, if present, must be a string" });
  }

  // platform
  if (typeof candidate.platform !== "string" || candidate.platform.length === 0) {
    issues.push({ path: "/platform", message: "platform is required and must be a non-empty string" });
  }

  // conformance
  if (!isConformanceStatus(candidate.conformance)) {
    issues.push({
      path: "/conformance",
      message: 'conformance is required and must be one of "unverified", "self-reported", "verified"',
    });
  }

  // version (optional)
  if (candidate.version !== undefined && typeof candidate.version !== "string") {
    issues.push({ path: "/version", message: "version, if present, must be a string" });
  }

  // homepage (optional)
  if (candidate.homepage !== undefined && typeof candidate.homepage !== "string") {
    issues.push({ path: "/homepage", message: "homepage, if present, must be a string" });
  }

  // capabilities
  const caps = candidate.capabilities;
  if (!Array.isArray(caps)) {
    issues.push({ path: "/capabilities", message: "capabilities is required and must be an array" });
  } else if (caps.length === 0) {
    issues.push({
      path: "/capabilities",
      message: "capabilities must list at least one mapping (an adapter that maps nothing is not useful)",
    });
  } else {
    caps.forEach((cap, i) => {
      const base = `/capabilities/${i}`;
      if (!isPlainObject(cap)) {
        issues.push({ path: base, message: "each capability must be an object" });
        return;
      }
      if (!isCapabilityDirection(cap.direction)) {
        issues.push({
          path: `${base}/direction`,
          message: 'direction is required and must be "inbound" or "outbound"',
        });
      }
      if (typeof cap.entity !== "string" || cap.entity.length === 0) {
        issues.push({ path: `${base}/entity`, message: "entity is required and must be a non-empty string" });
      }
      if (typeof cap.via !== "string" || cap.via.length === 0) {
        issues.push({ path: `${base}/via`, message: "via is required and must be a non-empty string" });
      }
    });
  }

  if (issues.length > 0) return { valid: false, issues };
  // Validated field-by-field above; the shape now matches AdapterManifest.
  return { valid: true, manifest: candidate as unknown as AdapterManifest };
}

/** Render a failed validation's issues into a single readable, multi-line string. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n");
}

/**
 * Validate and return the manifest, or throw an Error whose message lists every
 * issue. Convenience for callers that prefer exceptions over the result union.
 */
export function assertValidManifest(candidate: unknown): AdapterManifest {
  const result = validateManifest(candidate);
  if (!result.valid) {
    throw new Error(`invalid adapter manifest:\n${formatIssues(result.issues)}`);
  }
  return result.manifest;
}
