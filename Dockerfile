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

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/directory/package.json ./packages/directory/package.json
COPY --from=builder /app/packages/directory/dist ./packages/directory/dist

EXPOSE 3100

CMD ["node", "packages/directory/dist/index.js"]
