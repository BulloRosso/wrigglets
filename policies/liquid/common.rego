# Shared helpers of the Liquid Enterprise policies (ADR-0044).
# Data: data.liquid.ontology (generated from the ontology), data.liquid.roles (roles.json, policy as code),
# data.liquid.overlays (tightening overlays: control plane today, playbooks from M7).
package liquid.common

import rego.v1

# Overlays that are in force (not expired). An overlay can only ADD restrictions: deny or an obligation.
active_overlays contains o if {
	some o in data.liquid.overlays
	not expired(o)
}

expired(o) if {
	o.expires_at
	time.now_ns() >= time.parse_rfc3339_ns(o.expires_at)
}

# An overlay matches when every list it declares contains the call's value (missing list = any).
matches(o, ctx) if {
	list_ok(o.match, "actions", ctx.action)
	list_ok(o.match, "classes", ctx.class)
	list_ok(o.match, "upstreams", ctx.upstream)
	list_ok(o.match, "agents", ctx.agent)
}

list_ok(m, key, _) if not m[key]

list_ok(m, key, value) if value in m[key]

# Tasks whose plan a person approved run in the "run" (or "fix") step; the approval is the second pair of eyes.
approved_plan(task) if task.step in {"run", "fix"}
