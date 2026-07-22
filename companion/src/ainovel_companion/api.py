from __future__ import annotations

from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__
from .config import AppConfig
from .db import PublishingDB
from .sync import RemoteSynchronizer, SyncError


class EventRequest(BaseModel):
    event: str = Field(min_length=1, max_length=64)
    text_sha256: str = Field(min_length=64, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncRequest(BaseModel):
    run_export: bool = True


def create_app(config: AppConfig, db: PublishingDB, synchronizer: RemoteSynchronizer | None = None) -> FastAPI:
    app = FastAPI(title="Ainovel Publisher Companion", version=__version__)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Ainovel-Token"],
    )

    def require_token(x_ainovel_token: str | None = Header(default=None)) -> None:
        if not x_ainovel_token or x_ainovel_token != config.api.token:
            raise HTTPException(status_code=401, detail="invalid_local_api_token")

    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "service": "ainovel-publisher-companion"}

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
        return row

    @app.post("/api/v1/books/{book_id}/chapters/{chapter_no}/events", dependencies=[Depends(require_token)])
    def record_event(book_id: str, chapter_no: int, request: EventRequest) -> dict[str, Any]:
        try:
            return db.record_event(book_id, chapter_no, request.event, request.text_sha256, request.payload)
        except KeyError:
            raise HTTPException(status_code=404, detail="chapter_not_found")
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
