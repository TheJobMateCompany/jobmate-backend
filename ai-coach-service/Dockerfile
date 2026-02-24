# ─── Stage: Development ────────────────────────────────────────
FROM python:3.12-slim AS development
WORKDIR /app
# Install dependencies first (layer cache optimization)
COPY ai-coach-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY ai-coach-service/src/ .
EXPOSE 8083
CMD ["python", "-u", "main.py"]

# ─── Stage: Builder ────────────────────────────────────────────
# Compile wheels for production stage
FROM python:3.12-slim AS builder
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip
COPY ai-coach-service/requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── Stage: Production ─────────────────────────────────────────
FROM python:3.12-slim AS production
WORKDIR /app
# Copy pre-installed packages from builder
COPY --from=builder /install /usr/local
COPY ai-coach-service/src/ .
EXPOSE 8083
# Run as non-root
RUN useradd -m jobmate
USER jobmate
CMD ["python", "-u", "main.py"]
