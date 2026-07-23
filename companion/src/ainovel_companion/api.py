from __future__ import annotations

import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .config import AppConfig
from .db import PublishingDB
from .planner import (
    DEFAULT_DAILY_LIMIT,
    DEFAULT_SLOT,
    DEFAULT_SLOTS,
    DEFAULT_TIMEZONE,
    PlanningError,
    build_publication_plan,
    quota_units_from_text,
)
from .sync import RemoteSynchronizer, SyncError


class EventRequest(BaseModel):
    event: str = Field(min_length=1, max_length=64)
    text_sha256: str = Field(min_length=64, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncRequest(BaseModel):
    run_export: bool = True


class PublicationPlanRequest(BaseModel):
    slot: str = Field(default=DEFAULT_SLOT, pattern=r"^\d{2}:\d{2}$")
    daily_limit: int = Field(default=DEFAULT_DAILY_LIMIT, ge=1, le=1000000)
    ai_policy: Literal["remember", "use", "no", "ask"] = "remember"
    start_date: date | None = None


class PlatformObservation(BaseModel):
    chapter_no: int = Field(ge=1)
    text_sha256: str = Field(min_length=64, max_length=64)
    publication_date: str = Field(min_length=10, max_length=10)
    publication_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    quota_units: int = Field(default=0, ge=0)
    platform_chapter_id: str | None = Field(default=None, max_length=200)
    platform_state: Literal["scheduled", "published"] = "scheduled"
    version_verified: bool = False
    evidence: str | None = Field(default=None, max_length=2000)
    plan_id: str | None = Field(default=None, min_length=1, max_length=64)


class PlatformObservationRequest(BaseModel):
    observations: list[PlatformObservation] = Field(min_length=1, max_length=500)


class ResumePlanItemRequest(BaseModel):
    text_sha256: str = Field(min_length=64, max_length=64)
    acknowledgement: Literal["platform_checked_no_submission"]


class RecoverUnsubmittedRequest(BaseModel):
    text_sha256: str = Field(min_length=64, max_length=64)
    acknowledgement: Literal["platform_checked_chapter_absent"]
    platform_found: Literal[False]
    evidence_url: str | None = Field(default=None, max_length=2000)


def create_app(config: AppConfig, db: PublishingDB, synchronizer: RemoteSynchronizer | None = None) -> FastAPI:
    app = FastAPI(title="Ainovel Publisher Companion", version=__version__)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Ainovel-Token", "X-Ainovel-Client-Version"],
    )

    def require_token(
        x_ainovel_token: str | None = Header(default=None),
        x_ainovel_client_version: str | None = Header(default=None),
    ) -> None:
        if not x_ainovel_token or x_ainovel_token != config.api.token:
            raise HTTPException(status_code=401, detail="invalid_local_api_token")
        # An unpacked Edge extension keeps its old service worker alive until Reload.
        # Fence every authenticated read at the API boundary so a stale background
        # cannot fetch a plan and mutate Fanqie before its first event write.
        if x_ainovel_client_version != __version__:
            raise HTTPException(
                status_code=409,
                detail=f"stale_extension_version:expected={__version__}",
            )

    publication = config.publication
    timezone_name = publication.timezone if publication else DEFAULT_TIMEZONE
    default_limit = publication.daily_limit if publication else DEFAULT_DAILY_LIMIT
    default_slot = publication.default_slot if publication else DEFAULT_SLOT
    slots = publication.slots if publication else DEFAULT_SLOTS
    default_ai_policy = publication.default_ai_policy if publication else "remember"

    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "required_client_version": __version__,
            "service": "ainovel-publisher-companion",
        }

    @app.get("/api/v1/settings/publication", dependencies=[Depends(require_token)])
    def publication_settings() -> dict[str, Any]:
        return {
            "timezone": timezone_name,
            "daily_limit": default_limit,
            "default_slot": default_slot,
            "slots": list(slots),
            "default_ai_policy": default_ai_policy,
            "automation_enabled": bool(publication.automation_enabled) if publication else False,
        }

    @app.get("/api/v1/books", dependencies=[Depends(require_token)])
    def books() -> dict[str, Any]:
        return {"books": db.list_books()}

    @app.get("/api/v1/books/{book_id}/chapters", dependencies=[Depends(require_token)])
    def chapters(
        book_id: str,
        status: str | None = None,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=1000),
    ) -> dict[str, Any]:
        return {"chapters": db.list_chapters(book_id, status=status, after=after, limit=limit)}

    @app.get("/api/v1/books/{book_id}/chapters/{chapter_no}", dependencies=[Depends(require_token)])
    def chapter(book_id: str, chapter_no: int) -> dict[str, Any]:
        row = db.get_chapter(book_id, chapter_no)
        if row is None:
            raise HTTPException(status_code=404, detail="chapter_not_found")
        row["events"] = db.list_events(book_id, chapter_no)
        row["recovery"] = db.get_chapter_recovery(book_id, chapter_no)
        return row

    @app.post(
        "/api/v1/books/{book_id}/chapters/{chapter_no}/recover-unsubmitted",
        dependencies=[Depends(require_token)],
    )
    def recover_unsubmitted_chapter(
        book_id: str,
        chapter_no: int,
        request: RecoverUnsubmittedRequest,
    ) -> dict[str, Any]:
        try:
            return db.recover_unsubmitted_chapter(
                book_id,
                chapter_no,
                request.text_sha256,
                acknowledgement=request.acknowledgement,
                platform_found=request.platform_found,
                evidence_url=request.evidence_url,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc.args[0]))
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/api/v1/books/{book_id}/chapters/{chapter_no}/events", dependencies=[Depends(require_token)])
    def record_event(book_id: str, chapter_no: int, request: EventRequest) -> dict[str, Any]:
        try:
            return db.record_event(book_id, chapter_no, request.event, request.text_sha256, request.payload)
        except KeyError:
            raise HTTPException(status_code=404, detail="chapter_not_found")
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/api/v1/books/{book_id}/platform-observations", dependencies=[Depends(require_token)])
    def platform_observations(book_id: str, request: PlatformObservationRequest) -> dict[str, Any]:
        recorded = []
        for observation in request.observations:
            try:
                date.fromisoformat(observation.publication_date)
            except ValueError:
                raise HTTPException(status_code=422, detail="invalid_platform_publication_date")
            if observation.platform_state == "scheduled" and observation.version_verified and not observation.publication_time:
                raise HTTPException(status_code=422, detail="verified_schedule_requires_publication_time")
            payload = observation.model_dump(exclude={"chapter_no", "text_sha256"})
            payload["platform_state"] = (
                observation.platform_state
                if observation.version_verified
                else f"{observation.platform_state}_unverified"
            )
            if observation.version_verified:
                event_type = "schedule_verified" if observation.platform_state == "scheduled" else "published"
            else:
                event_type = "schedule_observed" if observation.platform_state == "scheduled" else "published_observed"
            try:
                row = db.record_event(
                    book_id,
                    observation.chapter_no,
                    event_type,
                    observation.text_sha256,
                    payload,
                )
            except KeyError:
                raise HTTPException(status_code=404, detail=f"chapter_not_found:{observation.chapter_no}")
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
            recorded.append(row)
        return {"recorded": recorded}

    @app.get("/api/v1/books/{book_id}/publication-plans", dependencies=[Depends(require_token)])
    def publication_plans(book_id: str) -> dict[str, Any]:
        return {"plans": db.list_publication_plans(book_id)}

    @app.post("/api/v1/books/{book_id}/publication-plans", dependencies=[Depends(require_token)])
    def create_publication_plan(book_id: str, request: PublicationPlanRequest) -> dict[str, Any]:
        if request.daily_limit > default_limit:
            raise HTTPException(status_code=422, detail="daily_limit_exceeds_configured_safety_cap")
        candidates = db.list_plan_candidates(book_id)
        existing_schedules = db.list_verified_schedules(book_id)
        known_chapter_nos = {int(candidate["chapter_no"]) for candidate in candidates}
        for schedule in existing_schedules:
            if schedule.get("platform_state") != "scheduled" or int(schedule["chapter_no"]) in known_chapter_nos:
                continue
            existing_chapter = db.get_chapter(book_id, int(schedule["chapter_no"]))
            if existing_chapter:
                candidates.append(existing_chapter)
                known_chapter_nos.add(int(schedule["chapter_no"]))
        if not candidates:
            raise HTTPException(status_code=409, detail="no_plannable_chapters")
        try:
            items = build_publication_plan(
                [
                    {
                        **candidate,
                        "quota_units": quota_units_from_text(candidate.get("body", "")) or int(candidate["char_count"]),
                    }
                    for candidate in candidates
                ],
                existing_schedules,
                start_date=request.start_date,
                now=datetime.now(ZoneInfo(timezone_name)),
                timezone_name=timezone_name,
                daily_limit=request.daily_limit,
                slot=request.slot,
                slots=slots,
            )
        except PlanningError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        plan_id = uuid.uuid4().hex
        try:
            return db.create_publication_plan(
                book_id,
                timezone=timezone_name,
                daily_limit=request.daily_limit,
                default_slot=request.slot,
                ai_policy=request.ai_policy,
                items=[item.to_dict() for item in items],
                plan_id=plan_id,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="book_not_found")

    @app.get("/api/v1/publication-plans/{plan_id}", dependencies=[Depends(require_token)])
    def publication_plan(plan_id: str) -> dict[str, Any]:
        result = db.get_publication_plan(plan_id)
        if result is None:
            raise HTTPException(status_code=404, detail="plan_not_found")
        return result

    @app.post("/api/v1/publication-plans/{plan_id}/approve", dependencies=[Depends(require_token)])
    def approve_publication_plan(plan_id: str) -> dict[str, Any]:
        try:
            return db.approve_publication_plan(plan_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="plan_not_found")
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post(
        "/api/v1/publication-plans/{plan_id}/items/{chapter_no}/resume",
        dependencies=[Depends(require_token)],
    )
    def resume_publication_plan_item(
        plan_id: str,
        chapter_no: int,
        request: ResumePlanItemRequest,
    ) -> dict[str, Any]:
        try:
            return db.resume_plan_item(
                plan_id,
                chapter_no,
                request.text_sha256,
                acknowledgement=request.acknowledgement,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc.args[0]))
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.post("/api/v1/sync", dependencies=[Depends(require_token)])
    def sync(request: SyncRequest) -> dict[str, Any]:
        if synchronizer is None:
            raise HTTPException(status_code=503, detail="synchronizer_unavailable")
        try:
            return synchronizer.sync(run_export=request.run_export).to_dict()
        except SyncError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

    return app
