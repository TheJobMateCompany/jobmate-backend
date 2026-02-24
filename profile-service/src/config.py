"""Configuration for profile-service — loaded from environment variables."""

import os

DATABASE_URL: str = os.environ["DATABASE_URL"]
REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379")
HTTP_PORT: int = int(os.getenv("HTTP_PORT", "4001"))
GRPC_PORT: int = int(os.getenv("GRPC_PORT", "9081"))

# Absolute path to the proto directory inside the container.
# docker-compose mounts: ./proto → /app/proto
PROTO_DIR: str = os.getenv("PROTO_DIR", "/app/proto")
PROTO_FILE: str = os.path.join(PROTO_DIR, "user.proto")

# Directory where uploaded CVs are stored.
UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "/app/uploads")

# Maximum upload size in bytes (default 10 MB)
MAX_UPLOAD_BYTES: int = int(os.getenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
