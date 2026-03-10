FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY dist/ ./dist/

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8420
ENV DB_PATH=/data/beam-bus.sqlite
ENV DIRECTORY_URL=https://api.beam.directory

EXPOSE 8420

CMD ["node", "dist/server.js"]
