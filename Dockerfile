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
RUN npm run build

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/api/v1/health || exit 1

CMD ["node", "dist/main.js"]
