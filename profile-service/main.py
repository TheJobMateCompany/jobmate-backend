"""Entry-point: starts gRPC server + FastAPI HTTP health endpoint concurrently."""
from __future__ import annotations

import asyncio
import logging

import uvicorn
from fastapi import FastAPI
from pythonjsonlogger import jsonlogger

import config
import database
import grpc_server


# ─── Logging setup ────────────────────────────────────────────────────────────

def _configure_logging() -> None:
    handler = logging.StreamHandler()
    formatter = jsonlogger.JsonFormatter(
        "%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


# ─── FastAPI (HTTP) ───────────────────────────────────────────────────────────

app = FastAPI(title="profile-service", docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "profile-service"}


# ─── Main ─────────────────────────────────────────────────────────────────────

async def _main() -> None:
    _configure_logging()
    logger = logging.getLogger(__name__)

    # Warm up DB pool
    await database.get_pool()

    # Run gRPC server and uvicorn concurrently
    cfg = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=config.HTTP_PORT,
        log_config=None,  # use our custom logging
    )
    http_server = uvicorn.Server(cfg)

    logger.info(
        "Starting profile-service",
        extra={"http_port": config.HTTP_PORT, "grpc_port": config.GRPC_PORT},
    )

    await asyncio.gather(
        grpc_server.serve(),
        http_server.serve(),
    )


if __name__ == "__main__":
    asyncio.run(_main())
