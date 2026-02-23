.PHONY: help dev dev-build prod prod-down logs ps clean db-shell redis-shell db-reset

# Default target
help:
	@echo ""
	@echo "JobMate Backend — Available commands:"
	@echo ""
	@echo "  make dev          Start all services in development mode (with build)"
	@echo "  make dev-build    Force rebuild all dev images"
	@echo "  make prod         Start all services in production mode"
	@echo "  make prod-down    Stop production services"
	@echo "  make logs         Follow logs of all services"
	@echo "  make ps           Show running containers status"
	@echo "  make clean        Stop all services and remove volumes (destructive!)"
	@echo "  make db-shell     Open a psql shell in the postgres container"
	@echo "  make redis-shell  Open a redis-cli shell in the redis container"
	@echo "  make db-reset     Drop and recreate the database (destructive!)"
	@echo ""

# ── Development ────────────────────────────────────────────────
dev:
	docker compose up -d

dev-build:
	docker compose up -d --build

logs:
	docker compose logs -f

ps:
	docker compose ps

# ── Production ─────────────────────────────────────────────────
prod:
	docker compose -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.prod.yml down

# ── Utilities ──────────────────────────────────────────────────
db-shell:
	docker compose exec postgres psql -U $${POSTGRES_USER:-jobmate} -d $${POSTGRES_DB:-jobmate}

redis-shell:
	docker compose exec redis redis-cli

db-reset:
	@echo "⚠️  WARNING: This will destroy all data. Press Ctrl+C to cancel..."
	@sleep 3
	docker compose down -v
	docker compose up -d postgres redis
	@sleep 3
	@echo "✅ Database reset complete."

# ── Cleanup ────────────────────────────────────────────────────
clean:
	@echo "⚠️  WARNING: This will destroy all containers and volumes. Press Ctrl+C to cancel..."
	@sleep 3
	docker compose down -v --remove-orphans
	docker image prune -f
