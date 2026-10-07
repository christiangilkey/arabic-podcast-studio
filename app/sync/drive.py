"""Minimal Google Drive v3 client for the hidden appDataFolder."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

import httpx

API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3"
FIELDS = "id,name,size,modifiedTime,md5Checksum"


class DriveError(RuntimeError):
    pass


class Drive(Protocol):
    def list(self) -> list[dict[str, Any]]: ...
    def get(self, file_id: str) -> dict[str, Any]: ...
    def download(self, file_id: str) -> bytes: ...
    def download_to(self, file_id: str, dest: Path) -> None: ...
    def upload(self, name: str, data: bytes | Path, mime: str, file_id: str | None = None) -> dict[str, Any]: ...
    def delete(self, file_id: str) -> None: ...


class GoogleDrive:
    def __init__(self, token: Callable[[bool], str]) -> None:
        self._token = token
        self._client = httpx.Client(timeout=httpx.Timeout(120, connect=20), follow_redirects=True)

    def close(self) -> None:
        self._client.close()

    def _request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        for attempt in range(2):
            headers = dict(kw.pop("headers", {}) or {})
            headers["Authorization"] = f"Bearer {self._token(attempt > 0)}"
            resp = self._client.request(method, url, headers=headers, **kw)
            if resp.status_code == 401 and attempt == 0:
                kw["headers"] = {k: v for k, v in headers.items() if k != "Authorization"}
                continue
            if resp.status_code >= 400:
                raise DriveError(f"Google Drive error {resp.status_code}: {resp.text[:300]}")
            return resp
        raise DriveError("Google Drive rejected the sign-in.")

    def list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        token = None
        while True:
            params = {"spaces": "appDataFolder", "pageSize": 1000, "fields": f"nextPageToken,files({FIELDS})"}
            if token:
                params["pageToken"] = token
            data = self._request("GET", f"{API}/files", params=params).json()
            out.extend(data.get("files", []))
            token = data.get("nextPageToken")
            if not token:
                return out

    def get(self, file_id: str) -> dict[str, Any]:
        return self._request("GET", f"{API}/files/{file_id}", params={"fields": FIELDS}).json()

    def download(self, file_id: str) -> bytes:
        return self._request("GET", f"{API}/files/{file_id}", params={"alt": "media"}).content

    def download_to(self, file_id: str, dest: Path) -> None:
        tmp = dest.with_name(dest.name + ".part")
        headers = {"Authorization": f"Bearer {self._token(False)}"}
        with self._client.stream("GET", f"{API}/files/{file_id}", params={"alt": "media"}, headers=headers) as resp:
            if resp.status_code >= 400:
                raise DriveError(f"Google Drive download failed ({resp.status_code}).")
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_bytes(1 << 16):
                    fh.write(chunk)
        os.replace(tmp, dest)

    def upload(self, name: str, data: bytes | Path, mime: str, file_id: str | None = None) -> dict[str, Any]:
        meta: dict[str, Any] = {"name": name}
        if file_id is None:
            meta["parents"] = ["appDataFolder"]
        if isinstance(data, Path):
            return self._upload_resumable(meta, data, mime, file_id)
        boundary = "aps-boundary-7f3c"
        body = (
            f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
            f"--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
        ).encode("utf-8") + data + f"\r\n--{boundary}--".encode("ascii")
        url = f"{UPLOAD}/files" + (f"/{file_id}" if file_id else "")
        resp = self._request("PATCH" if file_id else "POST", url, params={"uploadType": "multipart", "fields": FIELDS},
                             content=body, headers={"Content-Type": f"multipart/related; boundary={boundary}"})
        return resp.json()

    def _upload_resumable(self, meta: dict[str, Any], path: Path, mime: str, file_id: str | None) -> dict[str, Any]:
        url = f"{UPLOAD}/files" + (f"/{file_id}" if file_id else "")
        size = path.stat().st_size
        start = self._request("PATCH" if file_id else "POST", url,
                              params={"uploadType": "resumable", "fields": FIELDS},
                              json=meta if not file_id else {},
                              headers={"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size)})
        session_url = start.headers["Location"]
        with open(path, "rb") as fh:
            resp = self._client.put(session_url, content=fh.read(), headers={"Content-Type": mime})
        if resp.status_code >= 400:
            raise DriveError(f"Google Drive upload failed ({resp.status_code}): {resp.text[:200]}")
        return resp.json()

    def delete(self, file_id: str) -> None:
        self._request("DELETE", f"{API}/files/{file_id}")
