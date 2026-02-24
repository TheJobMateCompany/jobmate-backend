FROM python:3.12-slim AS production

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY discovery-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python source files only
COPY discovery-service/src/ .

# Copy shared proto definitions (baked into image for production)
COPY proto/ /app/proto/

EXPOSE 4002 9083

CMD ["python", "main.py"]
