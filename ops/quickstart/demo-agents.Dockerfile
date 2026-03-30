FROM node:22-slim AS sdk-builder

WORKDIR /repo

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
COPY packages/sdk-typescript/package.json ./packages/sdk-typescript/package.json

RUN npm ci --workspace=packages/sdk-typescript --include-workspace-root=false

COPY packages/sdk-typescript/README.md ./packages/sdk-typescript/README.md
COPY packages/sdk-typescript/tsconfig.json ./packages/sdk-typescript/tsconfig.json
COPY packages/sdk-typescript/src ./packages/sdk-typescript/src

RUN mkdir -p /tmp/release \
  && npm run build --workspace=packages/sdk-typescript \
  && npm pack --workspace=packages/sdk-typescript --pack-destination /tmp/release

FROM node:22-slim AS builder

WORKDIR /app

COPY ops/quickstart/demo-agents/package.json ./package.json
COPY --from=sdk-builder /tmp/release/beam-protocol-sdk-*.tgz /tmp/release/

RUN SDK_TARBALL="$(ls /tmp/release/beam-protocol-sdk-*.tgz)" \
  && npm pkg set dependencies.beam-protocol-sdk="file:${SDK_TARBALL}" \
  && npm install --omit=dev

COPY ops/quickstart/demo-agents/index.mjs ./index.mjs
COPY ops/quickstart/demo-identities.json ./demo-identities.json

FROM node:22-slim

WORKDIR /app

COPY ops/quickstart/demo-agents/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/index.mjs ./index.mjs
COPY --from=builder /app/demo-identities.json ./demo-identities.json

ENV NODE_ENV=production
ENV PORT=8790
ENV BEAM_DIRECTORY_URL=http://directory:3100
ENV BEAM_BUS_URL=http://message-bus:8420/v1/beam
ENV DEMO_IDENTITY_PATH=/app/demo-identities.json

EXPOSE 8790

CMD ["node", "index.mjs"]
