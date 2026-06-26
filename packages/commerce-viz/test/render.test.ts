/**
 * Verification by rendering: we render each primitive's state graph, then parse
 * the rendered SVG back out and assert the nodes and edges it contains match the
 * transition table — and we read that table directly from disk here, so the
 * expectations are DERIVED from schema/behavior/transitions.json, not hardcoded.
 * If the renderer dropped, duplicated, or invented a state or edge, this fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PRIMITIVES,
  TRANSITIONS_PATH,
  buildGraph,
  loadGraphs,
  type Primitive,
} from "../src/index.js";
import { renderHtml, renderSvg } from "../src/index.js";

// Read the frozen table independently of the renderer's own loader.
const TABLE = JSON.parse(readFileSync(TRANSITIONS_PATH, "utf8")) as Record<
  string,
  Record<string, string[]>
>;

/** Pull state names out of the rendered SVG via the data-state attribute. */
function parseNodes(svg: string): Set<string> {
  const out = new Set<string>();
  const re = /data-state="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.add(m[1]!);
  return out;
}

/** Pull edges out of the rendered SVG via the <title>from → to</title> tags. */
function parseEdges(svg: string): Set<string> {
  const out = new Set<string>();
  const re = /<title>([^<]+?) → ([^<]+?)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.add(`${m[1]}->${m[2]}`);
  return out;
}

/** Expected node/edge sets derived straight from the JSON table. */
function expected(primitive: Primitive) {
  const map = TABLE[primitive]!;
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const [from, tos] of Object.entries(map)) {
    nodes.add(from);
    for (const to of tos) {
      nodes.add(to);
      edges.add(`${from}->${to}`);
    }
  }
  return { nodes, edges };
}

describe("state-graph render is derived from the real transition table", () => {
  for (const primitive of PRIMITIVES) {
    it(`${primitive}: rendered nodes match the table`, () => {
      const g = buildGraph(primitive, TABLE[primitive]!);
      const svg = renderSvg(g);
      const exp = expected(primitive);
      expect([...parseNodes(svg)].sort()).toEqual([...exp.nodes].sort());
    });

    it(`${primitive}: rendered edges match the table exactly`, () => {
      const g = buildGraph(primitive, TABLE[primitive]!);
      const svg = renderSvg(g);
      const exp = expected(primitive);
      const got = parseEdges(svg);
      expect([...got].sort()).toEqual([...exp.edges].sort());
    });
  }

  it("commitment has the 26 transitions the schema documents", () => {
    // notes.commitment_count in the table is the schema's own claim; the render
    // must contain exactly that many commitment edges.
    const g = buildGraph("commitment", TABLE.commitment!);
    expect(g.edges.length).toBe(26);
    expect(parseEdges(renderSvg(g)).size).toBe(26);
  });

  it("terminal states (empty rows) are marked terminal in the SVG", () => {
    for (const primitive of PRIMITIVES) {
      const map = TABLE[primitive]!;
      const tableTerminals = Object.entries(map)
        .filter(([, tos]) => tos.length === 0)
        .map(([s]) => s);
      const svg = renderSvg(buildGraph(primitive, map));
      for (const t of tableTerminals) {
        const re = new RegExp(`class="node terminal" data-state="${t}"`);
        expect(svg, `${primitive}.${t} should be terminal`).toMatch(re);
      }
    }
  });

  it("combined HTML embeds every primitive graph", () => {
    const graphs = loadGraphs();
    const html = renderHtml(graphs);
    for (const primitive of PRIMITIVES) {
      expect(html).toContain(`data-primitive="${primitive}"`);
    }
    // Every edge across all primitives should appear in the page.
    let totalEdges = 0;
    for (const primitive of PRIMITIVES) totalEdges += expected(primitive).edges.size;
    expect(parseEdges(html).size).toBe(totalEdges);
  });

  it("loadGraphs (the renderer's own loader) agrees with the raw table", () => {
    const graphs = loadGraphs();
    for (const g of graphs) {
      const exp = expected(g.primitive);
      expect([...new Set(g.states)].sort()).toEqual([...exp.nodes].sort());
      expect(g.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([...exp.edges].sort());
    }
  });
});
