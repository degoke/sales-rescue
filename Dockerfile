# syntax=docker/dockerfile:1

# ── build: install all deps, compile TypeScript, then drop dev deps ───────────────────────────
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ── runtime: compiled JS, production deps and the seed fixtures only ──────────────────────────
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node fixtures ./fixtures
USER node
# Railway injects PORT; 8787 is the local default.
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/index.js"]
