# OPA's own API authorization (ADR-0044): OPA runs with --authentication=token --authorization=basic. Only decision
# queries with the query token and the health check are allowed; nobody can push policies or data through the REST API
# (they come only from the bundle the control plane signs off). No bundle loaded = this policy missing = everything
# denied (fail closed).
package system.authz

import rego.v1

default allow := false

allow if {
	input.method == "GET"
	input.path == ["health"]
}

allow if {
	input.method == "POST"
	input.path in [["v1", "data", "liquid", "gateway", "decision"], ["v1", "data", "liquid", "object", "decision"]]
	input.identity == data.system.authz.query_token
}
