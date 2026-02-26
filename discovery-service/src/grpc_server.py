"""gRPC server implementing DiscoveryService (discovery.proto)."""

from __future__ import annotations

import json
import logging
import os

import grpc
from grpc import aio
from grpc_reflection.v1alpha import reflection

import config
import database
import redis_client
import scraper
import url_scraper

logger = logging.getLogger(__name__)

_pb2 = None
_pb2_grpc = None


def _load_proto():
    global _pb2, _pb2_grpc
    if _pb2 is not None:
        return
    import sys

    import grpc_tools
    from grpc_tools import protoc

    proto_include = os.path.join(os.path.dirname(grpc_tools.__file__), "_proto")
    out_dir = "/tmp/discovery_service_proto"
    os.makedirs(out_dir, exist_ok=True)

    code = protoc.main(
        [
            "grpc_tools.protoc",
            f"--proto_path={config.PROTO_DIR}",
            f"--proto_path={proto_include}",
            f"--python_out={out_dir}",
            f"--grpc_python_out={out_dir}",
            config.PROTO_FILE,
        ]
    )
    if code != 0:
        raise RuntimeError(f"protoc compilation failed (code={code})")

    sys.path.insert(0, out_dir)
    import discovery_pb2 as _m
    import discovery_pb2_grpc as _g

    _pb2 = _m
    _pb2_grpc = _g


def _user_id_from_ctx(ctx: grpc.ServicerContext) -> str | None:
    for key, val in ctx.invocation_metadata():
        if key == "x-user-id":
            return val
    return None


async def _verify_search_config_ownership(
    pool, search_config_id: str, user_id: str
) -> bool:
    """Return True if the search config belongs to the user."""
    row = await pool.fetchrow(
        "SELECT id FROM search_configs WHERE id = $1 AND user_id = $2",
        search_config_id,
        user_id,
    )
    return row is not None


class DiscoveryServicer:

    async def AddJobByUrl(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")

        if not request.url:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "url is required")

        pool = await database.get_pool()

        # Validate search config ownership (optional field)
        search_config_id = request.search_config_id or None
        if search_config_id:
            if not await _verify_search_config_ownership(pool, search_config_id, uid):
                await context.abort(
                    grpc.StatusCode.NOT_FOUND, "search config not found"
                )

        # Scrape the URL
        job_data = await url_scraper.extract_job_from_url(request.url)

        # Red-flag check
        if scraper._has_red_flag(f"{job_data['title']} {job_data['description']}"):
            await context.abort(
                grpc.StatusCode.FAILED_PRECONDITION, "job contains red-flag content"
            )

                # Insert into job_feed (idempotent per user + source_url)
                # Do not rely on ON CONFLICT(source_url): production DB may not have a
                # matching UNIQUE/EXCLUDE constraint and source_url is not globally unique.
                row = await pool.fetchrow(
                        """
                        WITH existing AS (
                            SELECT id
                            FROM job_feed
                            WHERE user_id = $1 AND source_url = $3
                            LIMIT 1
                        ),
                        inserted AS (
                            INSERT INTO job_feed
                                (user_id, search_config_id, source_url, status, raw_data, is_manual,
                                 title, description)
                            SELECT $1, $2, $3, 'PENDING', $4, TRUE, $5, $6
                            WHERE NOT EXISTS (SELECT 1 FROM existing)
                            RETURNING id
                        )
                        SELECT id FROM inserted
                        UNION ALL
                        SELECT id FROM existing
                        LIMIT 1
                        """,
                        uid,
                        search_config_id,
                        request.url,
                        json.dumps(job_data),
                        job_data.get("title"),
                        job_data.get("description"),
                )
        job_feed_id = str(row["id"])

        await redis_client.publish(
            "EVENT_JOB_DISCOVERED",
            {
                "jobFeedId": job_feed_id,
                "userId": uid,
                "searchConfigId": search_config_id or "",
            },
        )

        return _pb2.AddJobByUrlResponse(
            job_feed_id=job_feed_id,
            message="Job added to your inbox",
        )

    async def AddJobManually(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")

        if not request.company_name:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "company_name is required"
            )

        pool = await database.get_pool()

        search_config_id = request.search_config_id or None
        if search_config_id:
            if not await _verify_search_config_ownership(pool, search_config_id, uid):
                await context.abort(
                    grpc.StatusCode.NOT_FOUND, "search config not found"
                )

        raw_data = {
            "company_name": request.company_name,
            "company_description": request.company_description,
            "location": request.location,
            "profile_wanted": request.profile_wanted,
            "start_date": request.start_date,
            "duration": request.duration,
            "why_us": request.why_us,
        }

        row = await pool.fetchrow(
            """
            INSERT INTO job_feed
              (user_id, search_config_id, source_url, status, raw_data,
               is_manual, title, description, company_name, company_description, why_us)
            VALUES ($1, $2, $3, 'PENDING', $4, TRUE, $5, $6, $7, $8, $9)
            RETURNING id
            """,
            uid,
            search_config_id,
            f"manual://{uid}/{request.company_name}",
            json.dumps(raw_data),
            request.company_name,
            request.profile_wanted or None,
            request.company_name,
            request.company_description or None,
            request.why_us or None,
        )
        job_feed_id = str(row["id"])

        await redis_client.publish(
            "EVENT_JOB_DISCOVERED",
            {
                "jobFeedId": job_feed_id,
                "userId": uid,
                "searchConfigId": search_config_id or "",
            },
        )

        return _pb2.AddJobManuallyResponse(
            job_feed_id=job_feed_id,
            message="Manual job added to your inbox",
        )

    async def TriggerScan(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")

        # Run in background — respond immediately
        import asyncio

        user_filter = request.user_id if request.user_id else None

        async def _bg():
            try:
                if user_filter:
                    pool = await database.get_pool()
                    rows = await pool.fetch(
                        """SELECT id, user_id, job_titles, locations
                           FROM search_configs WHERE user_id = $1 AND is_active = TRUE""",
                        user_filter,
                    )
                    for row in rows:
                        await scraper.run_for_config(
                            str(row["id"]),
                            str(row["user_id"]),
                            list(row["job_titles"] or []),
                            list(row["locations"] or []),
                        )
                else:
                    await scraper.run_all()
            except Exception as exc:
                logger.error("TriggerScan background error: %s", exc)

        asyncio.create_task(_bg())
        return _pb2.TriggerScanResponse(message="Scan triggered")


async def serve():
    _load_proto()

    servicer = DiscoveryServicer()
    server = aio.server()
    _pb2_grpc.add_DiscoveryServiceServicer_to_server(servicer, server)

    SERVICE_NAMES = (
        _pb2.DESCRIPTOR.services_by_name["DiscoveryService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(SERVICE_NAMES, server)

    addr = f"[::]:{config.GRPC_PORT}"
    server.add_insecure_port(addr)
    await server.start()
    logger.info("gRPC server listening on %s", addr)
    await server.wait_for_termination()
