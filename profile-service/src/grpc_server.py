"""gRPC server implementing ProfileService (user.proto)."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import UTC, datetime

import grpc
from google.protobuf import timestamp_pb2
from grpc import aio
from grpc_reflection.v1alpha import reflection

import config
import database
import redis_client

logger = logging.getLogger(__name__)

# ─── Proto loading ────────────────────────────────────────────────────────────
# Loaded lazily after grpc_tools path is set up
_pb2 = None
_pb2_grpc = None


def _load_proto():
    """Dynamically load generated proto modules from user.proto."""
    global _pb2, _pb2_grpc
    if _pb2 is not None:
        return
    import sys

    from grpc_tools import (
        _proto,  # type: ignore[import]
        protoc,
    )

    out_dir = "/tmp/profile_service_proto"
    os.makedirs(out_dir, exist_ok=True)

    proto_include = os.path.dirname(_proto.__file__)

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
    import user_pb2 as _m
    import user_pb2_grpc as _g

    _pb2 = _m
    _pb2_grpc = _g


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _ts(dt: datetime | None) -> timestamp_pb2.Timestamp:
    ts = timestamp_pb2.Timestamp()
    if dt:
        ts.FromDatetime(dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt)
    return ts


def _user_id_from_ctx(ctx: grpc.ServicerContext) -> str | None:
    for key, val in ctx.invocation_metadata():
        if key == "x-user-id":
            return val
    return None


def _row_to_search_config_proto(row: dict) -> object:
    sc = _pb2.SearchConfigProto(
        id=str(row["id"]),
        remote_policy=row.get("remote_policy") or "",
        salary_min=row.get("salary_min") or 0,
        salary_max=row.get("salary_max") or 0,
        is_active=row.get("is_active", True),
        start_date=str(row["start_date"]) if row.get("start_date") else "",
        duration=row.get("duration") or "",
        cover_letter_template=row.get("cover_letter_template") or "",
        created_at=_ts(row.get("created_at")),
        updated_at=_ts(row.get("updated_at")),
    )
    for f in ("job_titles", "locations", "keywords", "red_flags"):
        vals = row.get(f) or []
        if isinstance(vals, str):
            vals = json.loads(vals)
        getattr(sc, f).extend(vals)
    return sc


# ─── Servicer ─────────────────────────────────────────────────────────────────


class ProfileServicer:
    """Implements all ProfileService RPCs."""

    # ── Profile ────────────────────────────────────────────────────────────────

    async def GetProfile(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        pool = await database.get_pool()
        row = await pool.fetchrow(
            """SELECT id, user_id, full_name, status,
                      skills_json::text, experience_json::text, projects_json::text,
                      education_json::text, certifications_json::text, cv_url,
                      created_at, updated_at
               FROM profiles WHERE user_id = $1""",
            uid,
        )
        if not row:
            await context.abort(grpc.StatusCode.NOT_FOUND, "profile not found")
        return _pb2.ProfileProto(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            full_name=row["full_name"] or "",
            status=row["status"] or "",
            skills_json=row["skills_json"] or "[]",
            experience_json=row["experience_json"] or "[]",
            projects_json=row["projects_json"] or "[]",
            education_json=row["education_json"] or "[]",
            certifications_json=row["certifications_json"] or "[]",
            cv_url=row["cv_url"] or "",
            created_at=_ts(row["created_at"]),
            updated_at=_ts(row["updated_at"]),
        )

    # ── SearchConfig CRUD ──────────────────────────────────────────────────────

    async def GetSearchConfigs(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        pool = await database.get_pool()
        rows = await pool.fetch(
            """SELECT id, job_titles, locations, remote_policy, keywords, red_flags,
                      salary_min, salary_max, is_active, start_date, duration,
                      cover_letter_template, created_at, updated_at
               FROM search_configs WHERE user_id = $1 ORDER BY created_at DESC""",
            uid,
        )
        return _pb2.GetSearchConfigsResponse(
            configs=[_row_to_search_config_proto(dict(r)) for r in rows]
        )

    async def CreateSearchConfig(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        if not request.job_titles or not request.locations:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                "job_titles and locations are required",
            )
        pool = await database.get_pool()
        row = await pool.fetchrow(
            """INSERT INTO search_configs
                 (user_id, job_titles, locations, remote_policy, keywords, red_flags,
                  salary_min, salary_max, start_date, duration, cover_letter_template)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id, job_titles, locations, remote_policy, keywords, red_flags,
                         salary_min, salary_max, is_active, start_date, duration,
                         cover_letter_template, created_at, updated_at""",
            uid,
            list(request.job_titles),
            list(request.locations),
            request.remote_policy or "HYBRID",
            list(request.keywords),
            list(request.red_flags),
            request.salary_min or 0,
            request.salary_max or 0,
            request.start_date or None,
            request.duration or None,
            request.cover_letter_template or None,
        )
        return _row_to_search_config_proto(dict(row))

    async def UpdateSearchConfig(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        pool = await database.get_pool()
        row = await pool.fetchrow(
            """UPDATE search_configs SET
                 job_titles          = CASE WHEN $3::text[] IS NOT NULL THEN $3 ELSE job_titles END,
                 locations           = CASE WHEN $4::text[] IS NOT NULL THEN $4 ELSE locations END,
                 remote_policy       = COALESCE(NULLIF($5,''), remote_policy),
                 keywords            = CASE WHEN $6::text[] IS NOT NULL THEN $6 ELSE keywords END,
                 red_flags           = CASE WHEN $7::text[] IS NOT NULL THEN $7 ELSE red_flags END,
                 salary_min          = CASE WHEN $8 <> 0 THEN $8 ELSE salary_min END,
                 salary_max          = CASE WHEN $9 <> 0 THEN $9 ELSE salary_max END,
                 start_date          = COALESCE(NULLIF($10,'')::date, start_date),
                 duration            = COALESCE(NULLIF($11,''), duration),
                 cover_letter_template = COALESCE(NULLIF($12,''), cover_letter_template),
                 updated_at          = NOW()
               WHERE id = $1 AND user_id = $2
               RETURNING id, job_titles, locations, remote_policy, keywords, red_flags,
                         salary_min, salary_max, is_active, start_date, duration,
                         cover_letter_template, created_at, updated_at""",
            request.id,
            uid,
            list(request.job_titles) if request.job_titles else None,
            list(request.locations) if request.locations else None,
            request.remote_policy,
            list(request.keywords) if request.keywords else None,
            list(request.red_flags) if request.red_flags else None,
            request.salary_min,
            request.salary_max,
            request.start_date,
            request.duration,
            request.cover_letter_template,
        )
        if not row:
            await context.abort(grpc.StatusCode.NOT_FOUND, "search config not found")
        return _row_to_search_config_proto(dict(row))

    async def DeleteSearchConfig(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        pool = await database.get_pool()
        result = await pool.execute(
            "DELETE FROM search_configs WHERE id = $1 AND user_id = $2",
            request.id,
            uid,
        )
        deleted = result.split()[-1] != "0"
        return _pb2.DeleteSearchConfigResponse(success=deleted)

    # ── CV ─────────────────────────────────────────────────────────────────────

    async def UploadCV(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        if not request.file_bytes:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "file_bytes is required"
            )
        if len(request.file_bytes) > config.MAX_UPLOAD_BYTES:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "file exceeds 10 MB limit"
            )
        if request.mime_type not in ("application/pdf",):
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, "only PDF files are accepted"
            )

        os.makedirs(config.UPLOAD_DIR, exist_ok=True)
        safe_name = f"{uid}-{uuid.uuid4().hex}.pdf"
        file_path = os.path.join(config.UPLOAD_DIR, safe_name)
        with open(file_path, "wb") as f:
            f.write(request.file_bytes)

        cv_url = f"/uploads/{safe_name}"
        pool = await database.get_pool()
        await pool.execute(
            "UPDATE profiles SET cv_url = $1, updated_at = NOW() WHERE user_id = $2",
            cv_url,
            uid,
        )
        return _pb2.UploadCVResponse(cv_url=cv_url, message="CV uploaded successfully")

    async def ParseCV(self, request, context):
        uid = _user_id_from_ctx(context)
        if not uid:
            await context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing x-user-id")
        if not request.cv_url:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "cv_url is required")

        await redis_client.publish(
            "CMD_PARSE_CV",
            {
                "userId": uid,
                "cvUrl": request.cv_url,
            },
        )
        return _pb2.ParseCVResponse(success=True, message="CV parsing queued")


# ─── Server bootstrap ─────────────────────────────────────────────────────────


async def serve():
    _load_proto()

    servicer = ProfileServicer()
    server = aio.server()
    _pb2_grpc.add_ProfileServiceServicer_to_server(servicer, server)

    # Enable gRPC reflection (useful for debugging with grpcurl)
    SERVICE_NAMES = (
        _pb2.DESCRIPTOR.services_by_name["ProfileService"].full_name,
        reflection.SERVICE_NAME,
    )
    reflection.enable_server_reflection(SERVICE_NAMES, server)

    addr = f"[::]:{config.GRPC_PORT}"
    server.add_insecure_port(addr)
    await server.start()
    logger.info("gRPC server listening on %s", addr)
    await server.wait_for_termination()
