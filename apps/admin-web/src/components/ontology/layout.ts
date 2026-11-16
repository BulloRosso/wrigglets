import dagre from '@dagrejs/dagre';
import type { OntologyGraph } from '@cw/ontology-ir';

/* Auto-layout of the ontology graph (top to bottom: referencing classes above the classes they refer to). */

export const NODE_WIDTH = 230;
export const nodeHeight = (fields: number, actions: number) => 64 + Math.min(fields, 6) * 18 + (actions ? 26 : 0);

export function autoLayout(g: OntologyGraph, visible: Set<string>): Record<string, { x: number; y: number }> {
  const d = new dagre.graphlib.Graph();
  d.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 110, marginx: 20, marginy: 20 });
  d.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) if (visible.has(n.id)) d.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight(n.fields.length, n.actions.length) });
  for (const e of g.edges) if (visible.has(e.source) && visible.has(e.target) && e.source !== e.target) d.setEdge(e.source, e.target);
  dagre.layout(d);
  const out: Record<string, { x: number; y: number }> = {};
  for (const id of d.nodes()) {
    const n = d.node(id) as { x: number; y: number; width: number; height: number };
    out[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2 };
  }
  return out;
}

const KEY = 'cw.liquid.ontology.positions';
/** Node positions the user dragged, per ontology name (per browser; storage may be unavailable). */
export function loadPositions(ontology: string): Record<string, { x: number; y: number }> {
  try {
    return (JSON.parse(localStorage.getItem(`${KEY}.${ontology}`) ?? '{}') as Record<string, { x: number; y: number }>) ?? {};
  } catch {
    return {};
  }
}
export function savePositions(ontology: string, p: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(`${KEY}.${ontology}`, JSON.stringify(p));
  } catch {
    /* private window or blocked storage: positions are not remembered */
  }
}
export function clearPositions(ontology: string) {
  try {
    localStorage.removeItem(`${KEY}.${ontology}`);
  } catch {
    /* ignore */
  }
}
