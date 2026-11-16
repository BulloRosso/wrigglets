import { identifierOf, type IrAction, type IrClass, type OntologyIr } from './ir.js';

/*
 * Graph view of an ontology for the editor (E1): one node per class, one edge per link attribute. Pure and independent
 * of React Flow, so it is unit-tested here and the web app only maps it onto its components.
 */

export interface GraphNode {
  id: string;
  label: string;
  description?: string;
  identifier: string;
  criticality: IrClass['annotations']['criticality'];
  dataClass: IrClass['annotations']['data_class'];
  owner: string;
  group?: string;
  /** Scalar and enum attributes (links are edges). */
  fields: Array<{ name: string; range: string; kind: 'type' | 'enum'; required: boolean; multivalued: boolean; identifier: boolean }>;
  /** Actions whose target is this class. */
  actions: Array<Pick<IrAction, 'name' | 'kind' | 'readOnly' | 'destructive'>>;
  bound: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  required: boolean;
  multivalued: boolean;
}

export interface OntologyGraph {
  name: string;
  version: string;
  hash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Company-wide actions without a target class. */
  globalActions: Array<Pick<IrAction, 'name' | 'kind' | 'readOnly' | 'destructive'>>;
}

const actionSummary = (a: IrAction) => ({ name: a.name, kind: a.kind, readOnly: a.readOnly, destructive: a.destructive });

export function irToGraph(ir: OntologyIr): OntologyGraph {
  const bound = new Set(ir.bindings.map((b) => b.class));
  const nodes: GraphNode[] = ir.classes.map((c) => ({
    id: c.name,
    label: c.name,
    description: c.description,
    identifier: identifierOf(c).name,
    criticality: c.annotations.criticality,
    dataClass: c.annotations.data_class,
    owner: c.annotations.owner,
    group: c.annotations.mcp_group,
    fields: c.attributes.filter((a) => a.rangeKind !== 'class').map((a) => ({ name: a.name, range: a.range, kind: a.rangeKind as 'type' | 'enum', required: a.required, multivalued: a.multivalued, identifier: a.identifier })),
    actions: ir.actions.filter((a) => a.target === c.name).map(actionSummary),
    bound: bound.has(c.name),
  }));
  const edges: GraphEdge[] = ir.links.map((l) => ({ id: `${l.from}.${l.attribute}`, source: l.from, target: l.to, label: l.multivalued ? `${l.attribute} [*]` : l.attribute, required: l.required, multivalued: l.multivalued }));
  return { name: ir.name, version: ir.version, hash: ir.hash, nodes, edges, globalActions: ir.actions.filter((a) => !a.target).map(actionSummary) };
}

/** Classes matching a search text (name, description, field names) and optional filters. */
export function filterGraph(g: OntologyGraph, f: { text?: string; group?: string; criticality?: string }): Set<string> {
  const t = f.text?.trim().toLowerCase();
  return new Set(
    g.nodes
      .filter((n) => (!f.group || n.group === f.group) && (!f.criticality || n.criticality === f.criticality))
      .filter((n) => !t || n.label.toLowerCase().includes(t) || (n.description ?? '').toLowerCase().includes(t) || n.fields.some((x) => x.name.toLowerCase().includes(t)) || n.actions.some((a) => a.name.includes(t)))
      .map((n) => n.id),
  );
}
