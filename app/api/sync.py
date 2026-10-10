"""Google Drive sync endpoints: sign-in, status, manual sync."""

from __future__ import annotations

import html
import webbrowser
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .. import db, sync
from ..sync import oauth

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/status")
def status() -> dict[str, Any]:
    return sync.status()


@router.post("/login")
def login(request: Request) -> dict[str, Any]:
    # Google requires the system browser for sign-in (embedded webviews are blocked); it
    # redirects back to this local server.
    port = request.url.port
    redirect = f"http://127.0.0.1:{port}/api/sync/callback"
    try:
        url = oauth.begin(redirect)
    except oauth.AuthError as exc:
        raise HTTPException(400, str(exc)) from exc
    webbrowser.open(url)
    return {"ok": True, "url": url}


def _page(title: str, message: str, ok: bool) -> HTMLResponse:
    color = "#0f766e" if ok else "#b42318"
    return HTMLResponse(f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#f7f6f2">
<div style="max-width:440px;text-align:center"><h2 style="color:{color}">{html.escape(title)}</h2>
<p>{html.escape(message)}</p><p style="color:#6b6860">You can close this tab and return to Arabic Podcast Studio.</p></div>""")


@router.get("/callback", include_in_schema=False)
def callback(state: str = "", code: str = "", error: str = "") -> HTMLResponse:
    if error:
        return _page("Sign-in cancelled", "Google sign-in was cancelled or denied.", False)
    try:
        email = oauth.complete(state, code)
    except oauth.AuthError as exc:
        return _page("Sign-in failed", str(exc), False)
    except Exception as exc:  # network etc.
        return _page("Sign-in failed", f"{exc.__class__.__name__}: {exc}", False)
    sync.manager.start()
    sync.manager.request(delay=0.5)
    sync.manager._publish(state="idle")
    return _page("Signed in", f"Syncing as {email}.", True)


@router.post("/logout")
def logout() -> dict[str, Any]:
    oauth.sign_out()
    sync.manager._publish(state="idle", error=None)
    return sync.status()


@router.post("/id-token")
def google_id_token() -> dict[str, str]:
    """For the online features (friends, sharing): proves to Supabase who is signed in."""
    try:
        return {"token": oauth.id_token()}
    except oauth.AuthError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/now")
def sync_now() -> dict[str, Any]:
    if not oauth.signed_in():
        raise HTTPException(400, "Sign in with Google first.")
    sync.manager.request(delay=0)
    return sync.status()


class SyncSettings(BaseModel):
    sync_audio: bool


@router.patch("/settings")
def update_settings(body: SyncSettings) -> dict[str, Any]:
    db.set_settings({"sync_audio": body.sync_audio})
    return sync.status()
