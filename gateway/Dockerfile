# ─── Stage: Base ───────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

# ─── Stage: Development ────────────────────────────────────────
# Hot-reload via --watch (Node 20 built-in)
FROM base AS development
RUN npm install
COPY . .
EXPOSE 4000
CMD ["node", "--watch", "src/index.js"]

# ─── Stage: Builder ────────────────────────────────────────────
FROM base AS builder
RUN npm ci --only=production

# ─── Stage: Production ─────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
# Copy only production dependencies and source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY src ./src
EXPOSE 4000
# Run as non-root
USER node
CMD ["node", "src/index.js"]
