package liquid.object_test

import data.liquid.object
import rego.v1

req(action, agent, step, objects) := {"action": action, "caller": {"agent": agent, "task": {"id": "t-1", "step": step}}, "objects": objects}

po := {"class": "PurchaseOrder", "id": "PO-4411", "criticality": "payment_critical", "data_class": "confidential", "owner": "head-of-logistics", "status": "open"}

supplier := {"class": "Supplier", "id": "S-BALTIC", "criticality": "business_critical", "data_class": "confidential", "owner": "head-of-logistics", "status": "ok"}

test_agent_write_on_payment_critical_in_approved_task_ok if {
	d := object.decision with input as req("cancel_purchase_order", "sofa-lara", "run", [po])
	d.allow
	d.obligations == []
}

test_agent_write_on_payment_critical_without_approved_plan_needs_four_eyes if {
	d := object.decision with input as req("cancel_purchase_order", "sofa-lara", "", [po])
	d.allow
	d.obligations == ["require_four_eyes"]
}

test_create_of_payment_critical_class_without_plan_needs_four_eyes if {
	d := object.decision with input as req("create_purchase_order", "sofa-lara", "", [supplier])
	d.obligations == ["require_four_eyes"]
}

test_approval_by_another_person_satisfies_four_eyes if {
	d := object.decision with input as {"action": "cancel_purchase_order", "caller": {"agent": "sofa-lara", "user": "stefan@x", "approved_by": "ben@x", "task": {"step": ""}}, "objects": [po]}
	d.obligations == []
}

test_self_approval_does_not_count if {
	d := object.decision with input as {"action": "cancel_purchase_order", "caller": {"agent": "sofa-lara", "user": "stefan@x", "approved_by": "stefan@x", "task": {"step": ""}}, "objects": [po]}
	d.obligations == ["require_four_eyes"]
}

test_person_write_needs_no_four_eyes if {
	d := object.decision with input as {"action": "cancel_purchase_order", "caller": {"user": "stefan@x"}, "objects": [po]}
	d.allow
	d.obligations == []
}

# The ontology server sends absent caller fields as null (null is truthy in Rego): regression tests for both directions.
test_null_agent_is_not_an_agent if {
	d := object.decision with input as {"action": "cancel_purchase_order", "caller": {"agent": null, "user": "stefan@x", "approved_by": null, "workflow": "wf-1", "task": {"id": null, "step": null}}, "objects": [po]}
	d.allow
	d.obligations == []
}

test_null_approved_by_is_no_approval if {
	d := object.decision with input as {"action": "cancel_purchase_order", "caller": {"agent": "sofa-lara", "user": "stefan@x", "approved_by": null, "workflow": null, "task": {"id": null, "step": null}}, "objects": [po]}
	d.obligations == ["require_four_eyes"]
}

test_reads_have_no_obligations if {
	d := object.decision with input as req("list_purchase_orders", "sofa-lara", "", [])
	d.allow
	d.obligations == []
}

test_overlay_on_class_of_touched_object if {
	overlays := [{"id": "ov-9", "effect": "deny", "reason": "supplier data under review", "match": {"classes": ["Supplier"]}}]
	d := object.decision with input as req("create_purchase_order", "sofa-lara", "run", [supplier]) with data.liquid.overlays as overlays
	not d.allow
	contains(d.reason, "overlay ov-9")
}

test_overlay_step_up_obligation if {
	overlays := [{"id": "ov-10", "effect": "require_step_up", "reason": "suspicious", "match": {"actions": ["update_campaign"]}}]
	d := object.decision with input as req("update_campaign", "sofa-horst", "run", []) with data.liquid.overlays as overlays
	d.obligations == ["require_step_up"]
}

test_unknown_action_denied if {
	not object.decision.allow with input as req("nope", "sofa-lara", "run", [])
}
