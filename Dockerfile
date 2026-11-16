# ─── Stage 1: Install dependencies ─────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ─── Stage 2: Generate Prisma client ──────────────────────
FROM deps AS prisma
COPY prisma ./prisma
RUN npx prisma generate

# ─── Stage 3: Build the application ───────────────────────
FROM deps AS builder
WORKDIR /app
COPY --from=prisma /app/node_modules/.prisma ./node_modules/.prisma
COPY . .
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run build

# ─── Stage 4: Production image ────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 belivrhq
RUN adduser --system --uid 1001 belivrhq

# Copy only what's needed for production
COPY --from=builder --chown=belivrhq:belivrhq /app/dist ./dist
COPY --from=builder --chown=belivrhq:belivrhq /app/node_modules ./node_modules
COPY --from=builder --chown=belivrhq:belivrhq /app/package.json ./
COPY --from=prisma --chown=belivrhq:belivrhq /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=prisma --chown=belivrhq:belivrhq /app/node_modules/@prisma ./node_modules/@prisma

USER belivrhq

EXPOSE 3001

ENV NODE_ENV=production
ENV ENABLE_QUEUE_WORKERS=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/api/v1/health/live || exit 1

CMD ["node", "dist/main.js"]

# Persistent queue consumers have no HTTP listener. Their leased readiness is
# checked by the API; the host supervises this process and restarts failures.
FROM runner AS worker
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]

# Preserve the API as the default target for existing image builds.
FROM runner AS api
