FROM node:22-slim AS builder

WORKDIR /build

COPY packages/directory/package.json ./package.json
RUN npm install

COPY packages/directory/tsconfig.json ./tsconfig.json
COPY packages/directory/src ./src
RUN npm run build

FROM node:22-slim

ARG LITESTREAM_VERSION=0.5.9

WORKDIR /app

COPY packages/directory/package.json ./package.json
RUN npm install --omit=dev \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-amd64.tar.gz" -o /tmp/litestream.tar.gz \
  && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && chmod +x /usr/local/bin/litestream \
  && rm -rf /var/lib/apt/lists/* /tmp/litestream.tar.gz

COPY --from=builder /build/dist ./dist/
COPY packages/directory/catalog.yaml ./catalog.yaml
COPY litestream.yml ./litestream.yml

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3100
ENV DB_PATH=/data/beam-directory.db

EXPOSE 3100

CMD ["sh", "-c", "if [ -n \"$LITESTREAM_REPLICA_URL\" ]; then exec litestream replicate -config /app/litestream.yml -exec 'node dist/index.js'; else exec node dist/index.js; fi"]
