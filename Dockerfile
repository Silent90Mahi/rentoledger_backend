# syntax=docker/dockerfile:1
# RentOLedger API — production image.
#   docker build -t rentoledger-api .
#   docker run -p 4000:4000 --env-file .env rentoledger-api

ARG NODE_VERSION=22

# ---- Build: compile TypeScript -------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts are not needed to compile (and skip the embedded dev database download hook).
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Production dependencies only ------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Runtime ------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Run migrations separately (`node dist/src/db/cli.js migrate`) or set DB_AUTO_MIGRATE=true.
CMD ["node", "dist/src/server.js"]
