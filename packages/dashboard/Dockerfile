FROM node:22-slim

WORKDIR /app

ARG VITE_API_URL=http://localhost:3100
ARG VITE_BEAM_BUS_URL=http://localhost:8420

ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_BEAM_BUS_URL=${VITE_BEAM_BUS_URL}

COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json
COPY vite.config.ts ./vite.config.ts
COPY postcss.config.js ./postcss.config.js
COPY tailwind.config.js ./tailwind.config.js
COPY index.html ./index.html
COPY convex.json ./convex.json
COPY src ./src

RUN npm install && npm run build

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]

