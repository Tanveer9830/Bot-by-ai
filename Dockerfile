# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Bot-by-ai runtime image (bot + dashboard from one monorepo build).
# Multi-stage: full workspace build, then a slim runtime with production deps.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

# ---------------------------------------------------------------- deps + build
FROM base AS build
# NOTE: NODE_ENV stays 'production' here on purpose — running `next build` with
# NODE_ENV=development makes it fail while prerendering /404
# ("<Html> should not be imported outside of pages/_document"). Dev dependencies
# are pulled in explicitly with --include=dev instead.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/bot/package.json apps/bot/
COPY apps/dashboard/package.json apps/dashboard/
# Install with the lockfile so builds are reproducible.
RUN npm ci --include=dev --workspaces --include-workspace-root

# Only the TypeScript project files and sources are needed to build the images;
# .dockerignore keeps tests, docs and tooling config out of the context.
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY database database
RUN npm run build:packages \
 && npm run build -w @bot-by-ai/bot \
 && npm run build -w @bot-by-ai/dashboard

# --------------------------------------------------------------- prod modules
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/bot/package.json apps/bot/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force

# -------------------------------------------------------------------- runtime
FROM base AS runtime
# tini gives us correct signal handling so SIGTERM reaches Node for graceful shutdown.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/database/package.json packages/database/package.json
COPY --from=build /app/apps/bot/dist apps/bot/dist
COPY --from=build /app/apps/bot/package.json apps/bot/package.json
COPY --from=build /app/apps/dashboard/.next apps/dashboard/.next
COPY --from=build /app/apps/dashboard/next.config.mjs apps/dashboard/next.config.mjs
COPY --from=build /app/apps/dashboard/package.json apps/dashboard/package.json
COPY database database

# Run as the unprivileged user that ships with the node image.
USER node
ENV PORT=8080
EXPOSE 8080 3000

# The bot writes nothing to disk outside PostgreSQL, so a read-only root FS works
# (compose mounts a tmpfs for /tmp).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/bot/dist/index.js"]
