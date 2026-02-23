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
# Use alpine (not scratch) — the discovery service makes HTTPS calls to
# external APIs (Adzuna) and needs CA certificates.
FROM alpine:3.21 AS production
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/discovery-service ./discovery-service
EXPOSE 8081
USER nobody
ENTRYPOINT ["./discovery-service"]
