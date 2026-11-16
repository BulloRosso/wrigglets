package liquid.gateway_test

import data.liquid.gateway
import rego.v1

call(agent, action, step) := {"agent": {"id": agent}, "tool": concat("__", ["erp", action]), "upstream": "erp", "action": action, "task": {"id": "t-1", "step": step, "interactive": false}, "killSwitch": "normal"}

test_reads_open_to_every_agent if {
	gateway.decision.allow with input as call("sofa-horst", "list_suppliers", "plan")
	gateway.decision.allow with input as call("unknown-agent", "get_kpi", "run")
}

test_role_may_write_its_actions if {
	d := gateway.decision with input as call("sofa-lara", "create_purchase_order", "run")
	d.allow
	d.obligations == []
}

test_role_cannot_write_other_actions if {
	d := gateway.decision with input as call("sofa-horst", "create_purchase_order", "run")
	not d.allow
	contains(d.reason, "agent sofa-horst has no role that may run create_purchase_order")
}

test_unknown_agent_cannot_write if {
	not gateway.decision.allow with input as call("intruder", "request_overtime", "run")
}

test_plan_step_is_read_only if {
	d := gateway.decision with input as call("sofa-lara", "create_purchase_order", "plan")
	not d.allow
	contains(d.reason, "plan step is read-only")
}

test_destructive_needs_approved_plan if {
	not gateway.decision.allow with input as call("sofa-lara", "cancel_purchase_order", "")
	gateway.decision.allow with input as call("sofa-lara", "cancel_purchase_order", "run")
}

test_kill_switch_tools_off if {
	not gateway.decision.allow with input as object.union(call("sofa-lara", "list_suppliers", "run"), {"killSwitch": "tools_off"})
}

test_unknown_action_denied if {
	d := gateway.decision with input as call("sofa-lara", "drop_database", "run")
	not d.allow
	contains(d.reason, "unknown action drop_database")
}

test_overlay_denies_matching_calls_only if {
	overlays := [{"id": "ov-1", "effect": "deny", "reason": "upstream under review", "match": {"upstreams": ["erp"], "actions": ["create_purchase_order"]}}]
	d := gateway.decision with input as call("sofa-lara", "create_purchase_order", "run") with data.liquid.overlays as overlays
	not d.allow
	contains(d.reason, "overlay ov-1: upstream under review")
	gateway.decision.allow with input as call("sofa-max", "request_overtime", "run") with data.liquid.overlays as overlays
}

test_overlay_by_class if {
	overlays := [{"id": "ov-2", "effect": "deny", "reason": "suppliers frozen", "match": {"classes": ["Supplier"]}}]
	not gateway.decision.allow with input as call("sofa-lara", "list_suppliers", "run") with data.liquid.overlays as overlays
	gateway.decision.allow with input as call("sofa-lara", "list_purchase_orders", "run") with data.liquid.overlays as overlays
}

test_overlay_obligation_does_not_deny if {
	overlays := [{"id": "ov-3", "effect": "require_four_eyes", "reason": "vuln", "match": {"actions": ["create_purchase_order"]}}]
	d := gateway.decision with input as call("sofa-lara", "create_purchase_order", "run") with data.liquid.overlays as overlays
	d.allow
	d.obligations == ["require_four_eyes"]
}

test_expired_overlay_ignored if {
	overlays := [{"id": "ov-4", "effect": "deny", "reason": "old", "match": {}, "expires_at": "2000-01-01T00:00:00Z"}]
	gateway.decision.allow with input as call("sofa-lara", "get_kpi", "run") with data.liquid.overlays as overlays
}
