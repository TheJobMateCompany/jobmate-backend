# ─── Stage: Development ────────────────────────────────────────
# Uses 'air' for live-reload in dev (https://github.com/air-verse/air)
FROM golang:1.25-alpine AS development
WORKDIR /app
RUN go install github.com/air-verse/air@latest
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
CMD ["air", "-c", ".air.toml"]

# ─── Stage: Builder ────────────────────────────────────────────
# Produces a statically-linked binary (~10 MB)
FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o discovery-service ./cmd/main.go

# ─── Stage: Production ─────────────────────────────────────────
# Distroless / scratch — no shell, minimal attack surface
FROM scratch AS production
COPY --from=builder /app/discovery-service /discovery-service
EXPOSE 8081
ENTRYPOINT ["/discovery-service"]
