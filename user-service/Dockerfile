# ─── Stage: Base ───────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

# ─── Stage: Development ────────────────────────────────────────
FROM base AS development
RUN npm install
COPY . .
EXPOSE 4001
CMD ["node", "--watch", "src/index.js"]

# ─── Stage: Builder ────────────────────────────────────────────
FROM base AS builder
RUN npm ci --only=production

# ─── Stage: Production ─────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY src ./src
EXPOSE 4001
USER node
CMD ["node", "src/index.js"]
