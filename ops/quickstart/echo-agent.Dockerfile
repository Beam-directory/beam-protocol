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

COPY packages/echo-agent/package.json ./package.json
COPY --from=sdk-builder /tmp/release/beam-protocol-sdk-*.tgz /tmp/release/

RUN SDK_TARBALL="$(ls /tmp/release/beam-protocol-sdk-*.tgz)" \
  && npm pkg set dependencies.beam-protocol-sdk="file:${SDK_TARBALL}" \
  && npm install

COPY packages/echo-agent/tsconfig.json ./tsconfig.json
COPY packages/echo-agent/src ./src

RUN npm run build && npm prune --omit=dev

FROM node:22-slim

WORKDIR /app

COPY packages/echo-agent/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist/

ENV NODE_ENV=production
ENV PORT=8788
ENV BEAM_DIRECTORY_URL=http://directory:3100

EXPOSE 8788

CMD ["node", "dist/index.js"]
