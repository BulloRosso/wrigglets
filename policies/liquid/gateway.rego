# Gateway enforcement point (ADR-0044): queried by apps/mcp-gateway for tools of upstreams with policy "opa", AFTER the
# gateway's own allow-list check (decideToolCall). A second, independent line: roles from roles.json, not allow-lists.
#
# input: {agent: {id}, user: {upn, oid}, tool, upstream, action, task: {id, step, interactive}, killSwitch}
# result: data.liquid.gateway.decision = {allow, reason, obligations}
package liquid.gateway

import data.liquid.common
import rego.v1

action := data.liquid.ontology.actions[input.action]

role := data.liquid.roles.agents[input.agent.id]

ctx := {"action": input.action, "class": object.get(action, "target", null), "upstream": input.upstream, "agent": input.agent.id}

deny contains "kill switch: tools are off" if input.killSwitch == "tools_off"

deny contains sprintf("unknown action %v", [input.action]) if not data.liquid.ontology.actions[input.action]

# read-only planning, as a second line behind the gateway's own rule
deny contains "plan step is read-only" if {
	not action.read_only
	input.task.step == "plan"
}

# least privilege: writes only for the role's actions
deny contains sprintf("agent %v has no role that may run %v", [input.agent.id, input.action]) if {
	not action.read_only
	not role_allows
}

role_allows if input.action in data.liquid.roles.roles[role].writes

# destructive actions only after a person approved the plan
deny contains sprintf("%v is destructive: it needs an approved plan", [input.action]) if {
	action.destructive
	not common.approved_plan(input.task)
}

deny contains sprintf("overlay %v: %v", [o.id, o.reason]) if {
	some o in common.active_overlays
	o.effect == "deny"
	common.matches(o, ctx)
}

obligations contains o.effect if {
	some o in common.active_overlays
	o.effect != "deny"
	common.matches(o, ctx)
}

decision := {"allow": false, "reason": concat("; ", sort(deny)), "obligations": []} if {
	count(deny) > 0
} else := {"allow": true, "reason": "allowed", "obligations": sort(obligations)}
