import { classOf, identifierOf, type OntologyIr } from '@cw/ontology-ir';
import { header, json } from './util.js';

/*
 * OPA data (M4): data.liquid.ontology — classes with criticality, data class, owner; actions with their metadata and
 * the classification of their target. Data only; the rules live in policies/liquid (hand-written, tested). Plus a Rego
 * test skeleton that checks the data document is complete.
 */

export function opaData(ir: OntologyIr) {
  return {
    liquid: {
      ontology: {
        name: ir.name,
        version: ir.version,
        hash: ir.hash,
        classes: Object.fromEntries(
          ir.classes.map((c) => [c.name, { identifier: identifierOf(c).name, criticality: c.annotations.criticality, data_class: c.annotations.data_class, owner: c.annotations.owner, mcp_group: c.annotations.mcp_group ?? null }]),
        ),
        actions: Object.fromEntries(
          ir.actions.map((a) => {
            const t = a.target ? classOf(ir, a.target) : undefined;
            return [
              a.name,
              {
                target: a.target ?? null,
                kind: a.kind,
                read_only: a.readOnly,
                destructive: a.destructive,
                mcp_group: a.mcpGroup ?? null,
                criticality: t?.annotations.criticality ?? 'normal',
                data_class: t?.annotations.data_class ?? 'internal',
                owner: t?.annotations.owner ?? null,
                emits: a.emits,
              },
            ];
          }),
        ),
      },
    },
  };
}

export const genOpaData = (ir: OntologyIr) => json({ $generated: header(ir, '//').slice(3).trim(), ...opaData(ir) });

export function genOpaTest(ir: OntologyIr): string {
  return `${header(ir, '#')}package liquid.ontology_test

import rego.v1

# Every action has a kind and a known target (or none for company-wide queries).
test_actions_complete if {
	every name, a in data.liquid.ontology.actions {
		a.kind in {"query", "create", "update", "delete", "command"}
		a.target == null or data.liquid.ontology.classes[a.target]
	}
}

# Read-only actions are never destructive.
test_read_only_not_destructive if {
	count([name | some name, a in data.liquid.ontology.actions; a.read_only; a.destructive]) == 0
}

test_version if {
	data.liquid.ontology.version == "${ir.version}"
}
`;
}
