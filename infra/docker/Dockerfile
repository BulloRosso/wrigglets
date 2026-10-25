# syntax=docker/dockerfile:1.7
#
# One Dockerfile, four images (build with --target):
#   agent          – agent container: API/BFF + Temporal worker + Agent Harness (opencode)   [spec §5.1]
#   control-plane  – the "temporal" container: Temporal dev server + Web UI + admin console
#   oauth          – OpenID Connect server (node-oidc-provider) + sign-in pages
#   mock-llm       – OpenAI-compatible scripted model (stand-in for the AI gateway)
#
# All versions are pinned (spec §13 supply chain).

ARG NODE_IMAGE=node:24.22.1-bookworm-slim
ARG TEMPORAL_CLI_IMAGE=temporalio/temporal:1.9.1
ARG PNPM_VERSION=10.34.8
ARG HARNESS_VERSION=1.19.4

# ---------------------------------------------------------------- workspace build
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm i -g pnpm@${PNPM_VERSION} >/dev/null 2>&1
WORKDIR /src
# manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/agent-server/package.json apps/agent-server/
COPY apps/agent-web/package.json apps/agent-web/
COPY apps/admin-server/package.json apps/admin-server/
COPY apps/admin-web/package.json apps/admin-web/
COPY apps/oauth-server/package.json apps/oauth-server/
COPY apps/oauth-web/package.json apps/oauth-web/
COPY apps/mock-llm/package.json apps/mock-llm/
COPY apps/mcp-gateway/package.json apps/mcp-gateway/
COPY apps/mcp-demo/package.json apps/mcp-demo/
COPY packages/shared/package.json packages/shared/
COPY packages/workflows/package.json packages/workflows/
COPY packages/codec/package.json packages/codec/
COPY packages/harness-config/package.json packages/harness-config/
COPY packages/auth-rp/package.json packages/auth-rp/
COPY packages/ui/package.json packages/ui/
COPY packages/secrets/package.json packages/secrets/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm -r --workspace-concurrency=2 run build
# production-only dependency trees per server (workspace packages are copied in)
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @cw/agent-server deploy --legacy --prod /out/agent && \
    pnpm --filter @cw/admin-server deploy --legacy --prod /out/admin && \
    pnpm --filter @cw/oauth-server deploy --legacy --prod /out/oauth && \
    pnpm --filter @cw/mcp-gateway deploy --legacy --prod /out/mcp-gateway && \
    pnpm --filter @cw/mcp-demo deploy --legacy --prod /out/mcp-demo

# ---------------------------------------------------------------- mock-llm
FROM ${NODE_IMAGE} AS mock-llm
WORKDIR /app
COPY --from=build /src/apps/mock-llm/dist ./dist
COPY --from=build /src/apps/mock-llm/package.json ./
USER node
EXPOSE 4010
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- mcp-gateway (ADR-0021)
FROM ${NODE_IMAGE} AS mcp-gateway
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/mcp-gateway ./
ENV NODE_ENV=production DATA_DIR=/data PORT=7400
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7400
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- mcp-demo (example upstream MCP server)
FROM ${NODE_IMAGE} AS mcp-demo
WORKDIR /app
COPY --from=build /out/mcp-demo ./
ENV NODE_ENV=production PORT=7500
USER node
EXPOSE 7500
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- oauth
FROM ${NODE_IMAGE} AS oauth
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/oauth ./
COPY --from=build /src/apps/oauth-web/dist ./web
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST_DIR=/app/web PORT=9000
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 9000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- control-plane ("temporal" container)
FROM ${TEMPORAL_CLI_IMAGE} AS temporal-cli

FROM ${NODE_IMAGE} AS control-plane
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
# Temporal CLI (contains the dev server and the Temporal Web UI) — unmodified upstream binary.
COPY --from=temporal-cli /usr/local/bin/temporal /usr/local/bin/temporal
WORKDIR /app
COPY --from=build /out/admin ./
COPY --from=build /src/apps/admin-web/dist ./web
# Default guiding image for agent portraits (replaceable in the admin console)
COPY assets/agent-reference.png /app/assets/agent-reference.png
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST_DIR=/app/web PORT=8080 TEMPORAL_BIN=/usr/local/bin/temporal TEMPORAL_ADDRESS=127.0.0.1:7233
VOLUME ["/data"]
EXPOSE 7233 8233 8080
# Runs as root: it needs the Docker socket to manage agent containers (local only, see ADR-0003).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------- agent
FROM ${NODE_IMAGE} AS agent
ARG HARNESS_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini python3 python3-venv ripgrep util-linux \
    && rm -rf /var/lib/apt/lists/*
# Agent Harness, pinned, unmodified (spec §5.1, §6.1)
RUN npm i -g opencode-ai@${HARNESS_VERSION} && opencode --version
# Pre-warm the harness home (plugin dependencies) so that the container starts without
# npm registry access at runtime (relevant for locked-down egress on Azure, ADR-0007).
ENV HARNESS_HOME=/opt/harness-home
COPY infra/docker/agent/prewarm.sh /usr/local/bin/prewarm-harness
RUN chmod +x /usr/local/bin/prewarm-harness && /usr/local/bin/prewarm-harness && chown -R node:node /opt/harness-home
WORKDIR /app
COPY --from=build /out/agent ./
COPY --from=build /src/apps/agent-web/dist ./web
COPY infra/docker/agent/startup.sh /app/startup.sh
RUN chmod +x /app/startup.sh && mkdir -p /home/workspace /home/artifacts /home/staging /home/.oc && chown -R node:node /home
ENV NODE_ENV=production \
    HOME_ROOT=/home \
    WEB_DIST_DIR=/app/web \
    WORKFLOW_BUNDLE_PATH=/app/dist/workflow-bundle.js \
    HARNESS_CONFIG_PATH=/tmp/harness/opencode.json \
    HARNESS_VERSION=${HARNESS_VERSION} \
    PORT=8080
LABEL cw.image=agent org.opencontainers.image.title="coworking agent"
EXPOSE 8080
# Nothing from the app lives in /home (spec §5.1); /home is the persistent volume.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/startup.sh"]
