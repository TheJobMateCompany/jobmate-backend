"""Configuration for discovery-service."""
import os

DATABASE_URL: str = os.environ["DATABASE_URL"]
REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379")
HTTP_PORT: int = int(os.getenv("HTTP_PORT", "4002"))
GRPC_PORT: int = int(os.getenv("GRPC_PORT", "9083"))

# Proto path (mounted by docker-compose)
PROTO_DIR: str = os.getenv("PROTO_DIR", "/app/proto")
PROTO_FILE: str = os.path.join(PROTO_DIR, "discovery.proto")

# Adzuna API credentials
ADZUNA_APP_ID: str = os.getenv("ADZUNA_APP_ID", "")
ADZUNA_APP_KEY: str = os.getenv("ADZUNA_APP_KEY", "")
ADZUNA_COUNTRY: str = os.getenv("ADZUNA_COUNTRY", "fr")

# How often to run the automatic scrape (hours)
SCRAPE_INTERVAL_HOURS: float = float(os.getenv("SCRAPE_INTERVAL_HOURS", "6"))

# Red-flag keywords (comma-separated, override via env)
RED_FLAG_KEYWORDS: list[str] = [
    kw.strip().lower()
    for kw in os.getenv(
        "RED_FLAG_KEYWORDS",
        "mlm,multi-level,pyramid,scheme,unpaid,commission only,no base salary",
    ).split(",")
    if kw.strip()
]
