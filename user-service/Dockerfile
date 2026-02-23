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
RUN npm install --omit=dev && mkdir -p node_modules

# ─── Stage: Production ─────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY src ./src
# Create uploads dir as root, then give ownership to the node user
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
EXPOSE 4001
USER node
CMD ["node", "src/index.js"]
