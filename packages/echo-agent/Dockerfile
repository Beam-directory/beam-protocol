FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./package.json
RUN node -e "const v=require('node:child_process').execSync('npm -v').toString().trim(); if(Number(v.split('.')[0])<10){console.error('npm '+v+' is too old; need npm >= 10'); process.exit(1)}" \
 && npm install

COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist/

ENV NODE_ENV=production
ENV PORT=8788
ENV BEAM_DIRECTORY_URL=http://directory:3100

EXPOSE 8788

CMD ["node", "dist/index.js"]

