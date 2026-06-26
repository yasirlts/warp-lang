/**
 * Loads the REAL transition table from schema/behavior/transitions.json and
 * normalises it into a typed shape the renderer can walk. Nothing here is
 * hardcoded: the states and edges are read straight from the frozen schema. If
 * the schema changes, the rendered graph changes with it.
 *
 * This module reads, it does not define. The source of truth is the JSON.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/commerce-viz/src -> repo root is three levels up, then /schema.
export const SCHEMA_DIR = join(HERE, "..", "..", "..", "schema");
export const TRANSITIONS_PATH = join(SCHEMA_DIR, "behavior", "transitions.json");

/** A primitive whose lifecycle is described by a transition table. */
export type Primitive = "commitment" | "intent" | "fulfillment";

/** The three primitives we render, in a stable display order. */
export const PRIMITIVES: readonly Primitive[] = ["commitment", "intent", "fulfillment"];

/** One directed, legal transition: `from` may move to `to`. */
export interface Edge {
  from: string;
  to: string;
}

/** A primitive's lifecycle: its states and the legal moves between them. */
export interface StateGraph {
  primitive: Primitive;
  /** Every state that appears in the table (as a source or a target). */
  states: string[];
  /** Every legal transition, derived from the table rows. */
  edges: Edge[];
  /** States with no outgoing legal transition (an empty row in the table). */
  terminalStates: string[];
}

type TransitionMap = Record<string, string[]>;

interface TransitionsFile {
  "x-warp-schema-version"?: string;
  commitment: TransitionMap;
  intent: TransitionMap;
  fulfillment: TransitionMap;
  [key: string]: unknown;
}

/** Reads and parses the frozen transition table from disk. */
export function loadTransitionsFile(path: string = TRANSITIONS_PATH): TransitionsFile {
  return JSON.parse(readFileSync(path, "utf8")) as TransitionsFile;
}

/**
 * Builds a {@link StateGraph} for one primitive from its transition map.
 *
 * Derivation rules (all read from the table, none hardcoded):
 *  - A node exists for every key, and for every state that appears as a target.
 *  - An edge exists for every (source -> target) pair listed in the map.
 *  - A state is terminal when its row is an empty list.
 */
export function buildGraph(primitive: Primitive, map: TransitionMap): StateGraph {
  const stateSet = new Set<string>();
  const edges: Edge[] = [];
  const terminalStates: string[] = [];

  for (const [from, tos] of Object.entries(map)) {
    stateSet.add(from);
    if (tos.length === 0) terminalStates.push(from);
    for (const to of tos) {
      stateSet.add(to);
      edges.push({ from, to });
    }
  }

  return {
    primitive,
    states: [...stateSet],
    edges,
    terminalStates: terminalStates.sort(),
  };
}

/** Builds graphs for all three primitives from the frozen table. */
export function loadGraphs(path: string = TRANSITIONS_PATH): StateGraph[] {
  const file = loadTransitionsFile(path);
  return PRIMITIVES.map((p) => buildGraph(p, file[p]));
}
