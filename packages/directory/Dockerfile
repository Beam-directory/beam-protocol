FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY dist/ ./dist/
COPY catalog.yaml ./catalog.yaml

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3100
ENV DB_PATH=/data/beam-directory.db

EXPOSE 3100

CMD ["node", "dist/index.js"]
