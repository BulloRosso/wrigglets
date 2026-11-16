# GENERATED from ontology sofa@0.1.0 (0d44abb6df1c) — do not edit; run node scripts/liquid/ontology-build.mjs
package liquid.ontology_test

import rego.v1

# Every action has a kind and a known target (or none for company-wide queries).
test_actions_complete if {
	every _, a in data.liquid.ontology.actions {
		a.kind in {"query", "create", "update", "delete", "command"}
		target_known(a)
	}
}

target_known(a) if a.target == null

target_known(a) if data.liquid.ontology.classes[a.target]

# Read-only actions are never destructive.
test_read_only_not_destructive if {
	count([name | some name, a in data.liquid.ontology.actions; a.read_only; a.destructive]) == 0
}

test_version if {
	data.liquid.ontology.version == "0.1.0"
}
