FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./package.json
RUN node -e "const v=require('node:child_process').execSync('npm -v').toString().trim(); if(Number(v.split('.')[0])<10){console.error('npm '+v+' is too old; need npm >= 10'); process.exit(1)}" \
 && npm install --legacy-peer-deps

COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist/

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8420
ENV DB_PATH=/data/beam-bus.sqlite
ENV DIRECTORY_URL=https://api.beam.directory

EXPOSE 8420

CMD ["node", "dist/server.js"]
