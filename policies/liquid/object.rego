# Ontology server enforcement point (ADR-0044): object-level decision in the action pipeline, with the attributes of the
# objects the action touches (from the ontology: criticality, data class, owner; from the projection: status).
#
# input: {action, caller: {agent, user, task: {id, step}}, objects: [{class, id, criticality, data_class, owner, status}]}
# result: data.liquid.object.decision = {allow, reason, obligations}
# Obligations: require_four_eyes (the action waits for a person's approval), require_step_up (denied in the prototype).
package liquid.object

import data.liquid.common
import rego.v1

action := data.liquid.ontology.actions[input.action]

deny contains sprintf("unknown action %v", [input.action]) if not data.liquid.ontology.actions[input.action]

classes contains c if some c in {o.class | some o in input.objects}

classes contains action.target if action.target

deny contains sprintf("overlay %v: %v", [o.id, o.reason]) if {
	some o in common.active_overlays
	o.effect == "deny"
	some c in classes
	common.matches(o, {"action": input.action, "class": c, "upstream": null, "agent": input.caller.agent})
}

# Payment-critical objects: an agent may change them only with a second pair of eyes. In a task, the person who approved
# the plan is that second pair; anything else (chat, interactive calls) needs an explicit approval.
obligations contains "require_four_eyes" if {
	not action.read_only
	is_agent
	some o in input.objects
	o.criticality == "payment_critical"
	not common.approved_plan(input.caller.task)
	not approved_by_other_person
}

obligations contains "require_four_eyes" if {
	not action.read_only
	is_agent
	action.criticality == "payment_critical"
	not common.approved_plan(input.caller.task)
	not approved_by_other_person
}

# Caller fields are null when absent (the ontology server sends every key); null is truthy in Rego, so test for strings.
is_agent if {
	is_string(input.caller.agent)
	input.caller.agent != ""
}

# An explicit approval (ApprovalWorkflow, M5) by a person who is neither the agent nor the requesting user.
approved_by_other_person if {
	is_string(input.caller.approved_by)
	input.caller.approved_by != ""
	input.caller.approved_by != input.caller.agent
	input.caller.approved_by != object.get(input.caller, "user", null)
}

obligations contains o.effect if {
	some o in common.active_overlays
	o.effect != "deny"
	some c in classes
	common.matches(o, {"action": input.action, "class": c, "upstream": null, "agent": input.caller.agent})
}

decision := {"allow": false, "reason": concat("; ", sort(deny)), "obligations": []} if {
	count(deny) > 0
} else := {"allow": true, "reason": "allowed", "obligations": sort(obligations)}
