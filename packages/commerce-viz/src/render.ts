/**
 * Renders a {@link StateGraph} to a self-contained SVG document — nodes are
 * states, edges are legal transitions. The layout is a simple deterministic
 * layered placement (longest-path layering by BFS depth from source states),
 * which keeps the output stable for diffing and free of layout dependencies.
 *
 * This is a read-only visualizer: it draws the model, it does not execute it.
 */
import type { Edge, StateGraph } from "./transitions.js";

const NODE_W = 150;
const NODE_H = 40;
const H_GAP = 90; // horizontal gap between layers
const V_GAP = 24; // vertical gap between nodes in a layer
const MARGIN = 32;

interface Placed {
  state: string;
  layer: number;
  row: number;
  x: number;
  y: number;
}

/**
 * Assigns each state to a layer by its shortest distance from a source state
 * (a state that is never a transition target). Deterministic given the table.
 */
function layerStates(graph: StateGraph): Map<string, number> {
  const targets = new Set(graph.edges.map((e) => e.to));
  const sources = graph.states.filter((s) => !targets.has(s));
  // Fallback: if every state is a target (a cycle with no entry), seed with the
  // first state in table order so layering still terminates.
  const seeds = sources.length > 0 ? sources : graph.states.slice(0, 1);

  const adj = new Map<string, string[]>();
  for (const s of graph.states) adj.set(s, []);
  for (const e of graph.edges) adj.get(e.from)!.push(e.to);

  const layer = new Map<string, number>();
  for (const s of seeds) layer.set(s, 0);
  const queue = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curLayer = layer.get(cur)!;
    for (const next of adj.get(cur) ?? []) {
      const cand = curLayer + 1;
      // Only deepen (never shorten) and avoid reprocessing cycles endlessly.
      if (!layer.has(next) || cand > layer.get(next)!) {
        // Guard against cycles inflating layers unboundedly.
        if (cand <= graph.states.length) {
          layer.set(next, cand);
          queue.push(next);
        }
      }
    }
  }
  // Any state still unlayered (unreachable from a source) goes to layer 0.
  for (const s of graph.states) if (!layer.has(s)) layer.set(s, 0);
  return layer;
}

function place(graph: StateGraph): { placed: Placed[]; width: number; height: number } {
  const layer = layerStates(graph);
  const byLayer = new Map<number, string[]>();
  for (const s of graph.states) {
    const l = layer.get(s)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s);
  }
  // Stable ordering inside each layer: table order is preserved by states[].
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

  const placed: Placed[] = [];
  let maxRows = 0;
  for (const l of layerKeys) {
    const states = byLayer.get(l)!;
    maxRows = Math.max(maxRows, states.length);
    states.forEach((state, row) => {
      placed.push({
        state,
        layer: l,
        row,
        x: MARGIN + l * (NODE_W + H_GAP),
        y: MARGIN + row * (NODE_H + V_GAP),
      });
    });
  }
  const width = MARGIN * 2 + (layerKeys.length) * NODE_W + (layerKeys.length - 1) * H_GAP;
  const height = MARGIN * 2 + maxRows * NODE_H + (maxRows - 1) * V_GAP;
  return { placed, width, height };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function edgePath(from: Placed, to: Placed): string {
  // Anchor on the right edge of source, left edge of target, with a gentle curve.
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/**
 * Renders one primitive's state graph as a standalone SVG string. The result is
 * deterministic for a given table, so it can be committed and diffed.
 */
export function renderSvg(graph: StateGraph): string {
  const { placed, width, height } = place(graph);
  const byState = new Map(placed.map((p) => [p.state, p]));
  const terminal = new Set(graph.terminalStates);

  const edgeEls = graph.edges
    .map((e: Edge) => {
      const from = byState.get(e.from)!;
      const to = byState.get(e.to)!;
      return `    <path class="edge" d="${edgePath(from, to)}" marker-end="url(#arrow)">\n      <title>${esc(e.from)} → ${esc(e.to)}</title>\n    </path>`;
    })
    .join("\n");

  const nodeEls = placed
    .map((p) => {
      const cls = terminal.has(p.state) ? "node terminal" : "node";
      return (
        `    <g class="${cls}" data-state="${esc(p.state)}">\n` +
        `      <rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="6"/>\n` +
        `      <text x="${p.x + NODE_W / 2}" y="${p.y + NODE_H / 2}">${esc(p.state)}</text>\n` +
        `    </g>`
      );
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-primitive="${esc(graph.primitive)}" data-state-count="${graph.states.length}" data-edge-count="${graph.edges.length}">
  <desc>Read-only state graph for the ${esc(graph.primitive)} primitive, derived from schema/behavior/transitions.json. ${graph.states.length} states, ${graph.edges.length} legal transitions.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#5b6470"/>
    </marker>
  </defs>
  <style>
    .edge { fill: none; stroke: #5b6470; stroke-width: 1.5; }
    .node rect { fill: #eef2f7; stroke: #2f6fed; stroke-width: 1.5; }
    .node.terminal rect { fill: #f7eeee; stroke: #c0392b; }
    .node text { font: 13px ui-sans-serif, system-ui, sans-serif; fill: #1b1f24; text-anchor: middle; dominant-baseline: central; }
  </style>
  <g class="edges">
${edgeEls}
  </g>
  <g class="nodes">
${nodeEls}
  </g>
</svg>
`;
}

/**
 * Wraps one or more SVG graphs in a single self-contained HTML page with a
 * heading per primitive. No external assets, no framework — it opens in any
 * browser straight from disk.
 */
export function renderHtml(graphs: StateGraph[]): string {
  const sections = graphs
    .map(
      (g) =>
        `  <section>\n    <h2>${esc(g.primitive)} <small>${g.states.length} states, ${g.edges.length} transitions</small></h2>\n${renderSvg(g)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")}\n  </section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Warp Commerce Model — state graphs</title>
  <style>
    body { font: 15px ui-sans-serif, system-ui, sans-serif; color: #1b1f24; margin: 2rem; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.1rem; text-transform: capitalize; margin-top: 2rem; }
    h2 small { font-weight: 400; color: #5b6470; font-size: 0.8rem; }
    p.note { color: #5b6470; max-width: 60ch; }
    section { overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Warp Commerce Model — state graphs</h1>
  <p class="note">A read-only render of the real transition table (schema/behavior/transitions.json). Nodes are states, arrows are legal transitions. Red-bordered nodes are terminal (no outgoing transition in the table).</p>
${sections}
</body>
</html>
`;
}
