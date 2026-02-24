FROM python:3.12-slim AS production

WORKDIR /app

# System deps for asyncpg
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY profile-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy service code
COPY profile-service/src/ .

# Copy shared proto definitions (baked into image for production)
COPY proto/ /app/proto/

EXPOSE 4001 9081

CMD ["python", "main.py"]
