"""Entry-point for discovery-service: scheduler + gRPC + HTTP health."""

from __future__ import annotations

import asyncio
import logging

import uvicorn
from fastapi import FastAPI
from pythonjsonlogger import jsonlogger

import config
import database
import grpc_server
import scheduler


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


app = FastAPI(title="discovery-service", docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "discovery-service"}


async def _main() -> None:
    _configure_logging()
    logger = logging.getLogger(__name__)

    await database.get_pool()
    scheduler.start()

    cfg = uvicorn.Config(app, host="0.0.0.0", port=config.HTTP_PORT, log_config=None)
    http_server = uvicorn.Server(cfg)

    logger.info(
        "Starting discovery-service",
        extra={"http_port": config.HTTP_PORT, "grpc_port": config.GRPC_PORT},
    )

    await asyncio.gather(
        grpc_server.serve(),
        http_server.serve(),
    )


if __name__ == "__main__":
    asyncio.run(_main())
