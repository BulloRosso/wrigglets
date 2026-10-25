#!/bin/sh
# Idempotent namespace bootstrap for a self-hosted Temporal cluster (spec §14.5), e.g. run from the
# temporalio/admin-tools Container Apps Job on Azure. Locally the admin server does the same through
# the operator API at start-up (apps/admin-server/src/temporal/platform.ts).
#
#   TEMPORAL_ADDRESS=temporal-frontend.internal:7233 NAMESPACE=agent-prod ./bootstrap.sh
#   (add --tls-cert-path/--tls-key-path/--tls-ca-path via TEMPORAL_CLI_TLS_ARGS for mTLS)
set -eu

NAMESPACE="${NAMESPACE:-agent-prod}"
RETENTION="${RETENTION:-90d}"
ADDR="--address ${TEMPORAL_ADDRESS:-localhost:7233} ${TEMPORAL_CLI_TLS_ARGS:-}"

if temporal operator namespace describe $ADDR --namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "namespace $NAMESPACE exists — updating retention"
  # a freshly registered namespace needs a few seconds until it can be updated (namespace cache)
  for i in 1 2 3 4 5 6; do
    temporal operator namespace update $ADDR --namespace "$NAMESPACE" --retention "$RETENTION" && break
    sleep 5
  done
else
  temporal operator namespace create $ADDR --namespace "$NAMESPACE" --retention "$RETENTION"
  sleep 10 # namespace cache refresh before search attributes can be added
fi

# One call per attribute keeps the script independent of multi-attribute CLI syntax; "already exists" is ignored.
for def in AgentId:Keyword RequestedBy:Keyword TaskType:Keyword TaskStatus:Keyword TaskTitle:Text Trigger:Keyword ScheduleId:Keyword ApprovedBy:KeywordList; do
  name="${def%%:*}"; type="${def##*:}"
  if temporal operator search-attribute create $ADDR --namespace "$NAMESPACE" --name "$name" --type "$type" 2>/tmp/sa.err; then
    echo "created $name ($type)"
  elif grep -qi "already" /tmp/sa.err; then
    echo "exists  $name"
  else
    cat /tmp/sa.err >&2; exit 1
  fi
done
