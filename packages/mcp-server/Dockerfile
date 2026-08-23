# syntax=docker/dockerfile:1.7

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/sdk-typescript/package.json packages/sdk-typescript/tsconfig.json ./packages/sdk-typescript/
COPY packages/mcp-server/package.json packages/mcp-server/tsconfig.json ./packages/mcp-server/

RUN npm ci --ignore-scripts \
  --workspace=beam-protocol-sdk \
  --workspace=@beam-protocol/mcp-server \
  --include-workspace-root=false

COPY packages/sdk-typescript/src ./packages/sdk-typescript/src
COPY packages/mcp-server/src ./packages/mcp-server/src

RUN npm run build --workspace=beam-protocol-sdk \
  && npm run build --workspace=@beam-protocol/mcp-server \
  && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

LABEL org.opencontainers.image.title="Beam MCP server" \
  org.opencontainers.image.description="Dedicated-tenant OAuth-protected MCP bridge for signed Beam handoffs" \
  org.opencontainers.image.source="https://github.com/Beam-directory/beam-protocol" \
  org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/packages/sdk-typescript/package.json ./packages/sdk-typescript/package.json
COPY --from=builder /workspace/packages/sdk-typescript/dist ./packages/sdk-typescript/dist
COPY --from=builder /workspace/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=builder /workspace/packages/mcp-server/dist ./packages/mcp-server/dist
COPY LICENSE ./LICENSE

# The runtime executes prebuilt JavaScript only. Removing package managers and
# their global dependency trees reduces both attack surface and image CVEs.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
  && rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
  BEAM_MCP_TRANSPORT=http \
  BEAM_MCP_HTTP_HOST=0.0.0.0 \
  BEAM_MCP_HTTP_PORT=3333

USER node
EXPOSE 3333
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const target=new URL(process.env.BEAM_MCP_PUBLIC_URL);const request=http.get({host:'127.0.0.1',port:process.env.BEAM_MCP_HTTP_PORT||'3333',path:'/health',headers:{host:target.host}},response=>process.exit(response.statusCode===200?0:1));request.setTimeout(2000,()=>request.destroy(new Error('health timeout')));request.on('error',()=>process.exit(1));"]

CMD ["node", "packages/mcp-server/dist/index.js"]
