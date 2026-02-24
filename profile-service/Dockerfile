FROM python:3.12-slim AS production

WORKDIR /app

# System deps for asyncpg
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy service code
COPY src/ .

# Copy proto definitions (mounted at /app/proto in compose)
# Volume handled in docker-compose.yml

EXPOSE 4001 9081

CMD ["python", "main.py"]
