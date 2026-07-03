# Build context is the repo root: docker build -f server/Dockerfile .
# Multi-stage so CI just runs `docker build` -- no separate npm build, no committed dist/.

FROM node:20-slim AS build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001 WEB_ROOT=./web
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY web ./web
EXPOSE 3001
CMD ["node", "dist/server.js"]
