FROM node:20-alpine AS builder

WORKDIR /app

# `better-sqlite3` compiles a native module on Alpine, so keep the build toolchain
# in the builder stage and copy only the runtime artifacts into the final image.
RUN apk add --no-cache python3 make g++

# Copy manifest files first so dependency installation stays cached when only source
# files change.
COPY package.json package-lock.json ./
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/directory/package.json ./packages/directory/package.json
COPY packages/sdk-typescript/package.json ./packages/sdk-typescript/package.json

RUN npm install

COPY . .

RUN npm run build --workspace=packages/directory
RUN npm prune --omit=dev


FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3100
ENV DB_PATH=/data/beam-directory.db

# S1: Install Litestream for SQLite → S3 streaming replication
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64-static.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin/ && rm /tmp/litestream.tar.gz

COPY litestream.yml /etc/litestream.yml

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/directory/package.json ./packages/directory/package.json
COPY --from=builder /app/packages/directory/dist ./packages/directory/dist

EXPOSE 3100

# If Litestream env vars are set, use Litestream as process wrapper (auto-restore + replicate).
# Otherwise, run Node.js directly (backward compatible).
CMD if [ -n "$LITESTREAM_REPLICA_BUCKET" ]; then \
      litestream restore -if-db-not-exists -config /etc/litestream.yml ${DB_PATH} && \
      exec litestream replicate -exec "node packages/directory/dist/index.js" -config /etc/litestream.yml; \
    else \
      exec node packages/directory/dist/index.js; \
    fi
