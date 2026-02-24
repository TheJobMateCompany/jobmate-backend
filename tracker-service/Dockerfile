# ─── Stage: Development ────────────────────────────────────────
FROM golang:1.24-alpine AS development
WORKDIR /app
RUN go install github.com/air-verse/air@latest
COPY go.mod go.sum* ./
RUN go mod tidy
COPY . .
CMD ["air", "-c", ".air.toml"]

# ─── Stage: Builder ────────────────────────────────────────────
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod tidy
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o tracker-service ./cmd/main.go

# ─── Stage: Production ─────────────────────────────────────────
FROM scratch AS production
COPY --from=builder /app/tracker-service /tracker-service
EXPOSE 8082
ENTRYPOINT ["/tracker-service"]
