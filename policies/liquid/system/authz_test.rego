package system.authz_test

import data.system.authz
import rego.v1

test_decision_query_with_token if {
	authz.allow with input as {"method": "POST", "path": ["v1", "data", "liquid", "gateway", "decision"], "identity": "t0k"} with data.system.authz.query_token as "t0k"
}

test_decision_query_wrong_token if {
	not authz.allow with input as {"method": "POST", "path": ["v1", "data", "liquid", "gateway", "decision"], "identity": "x"} with data.system.authz.query_token as "t0k"
}

test_no_policy_or_data_writes if {
	not authz.allow with input as {"method": "PUT", "path": ["v1", "data", "liquid", "overlays"], "identity": "t0k"} with data.system.authz.query_token as "t0k"
	not authz.allow with input as {"method": "PUT", "path": ["v1", "policies", "x"], "identity": "t0k"} with data.system.authz.query_token as "t0k"
	not authz.allow with input as {"method": "POST", "path": ["v1", "data", "liquid", "common"], "identity": "t0k"} with data.system.authz.query_token as "t0k"
}

test_health_open if {
	authz.allow with input as {"method": "GET", "path": ["health"]}
}
