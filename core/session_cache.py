from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

from models import SessionCacheEntry, SessionEntry

SESSIONS_DIR = Path(__file__).resolve().parent.parent / "sessions"


class SessionCacheError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        super().__init__(message or code)


def sanitize_email(email: str) -> str:
    e = (email or "").strip().lower()
    if not e or ".." in e or "/" in e or "\\" in e:
        raise SessionCacheError("invalid_email", "invalid email for path")
    return e


def should_reuse(expires_at: int, now: float | int, buffer: int = 300) -> bool:
    return (expires_at - int(now)) > buffer


class SessionCache:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or SESSIONS_DIR
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, email: str) -> Path:
        safe = sanitize_email(email)
        return self.root / f"{safe}.json"

    def read(self, email: str) -> Optional[SessionEntry]:
        path = self._path(email)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return SessionEntry.model_validate(data)
        except Exception:
            return None

    def write(self, entry: SessionEntry) -> None:
        path = self._path(entry.email)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = entry.model_dump(mode="json")
        data = json.dumps(payload, ensure_ascii=False, indent=2)
        fd = os.open(
            str(path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, data.encode("utf-8"))
        finally:
            os.close(fd)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def delete(self, email: str) -> bool:
        path = self._path(email)
        if not path.exists():
            return False
        path.unlink()
        return True

    def mark_invalid(self, email: str) -> None:
        try:
            self.delete(email)
        except SessionCacheError:
            pass

    def list_entries(self, buffer: int = 300) -> list[SessionCacheEntry]:
        now = int(time.time())
        out: list[SessionCacheEntry] = []
        for p in sorted(self.root.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                exp = int(data.get("expires_at") or 0)
                out.append(
                    SessionCacheEntry(
                        email=str(data.get("email") or p.stem),
                        expires_at=exp,
                        created_at=int(data.get("created_at") or 0),
                        last_used_at=data.get("last_used_at"),
                        file_size_bytes=p.stat().st_size,
                        is_expired=not should_reuse(exp, now, buffer),
                    )
                )
            except Exception:
                continue
        return out

    def touch(self, email: str) -> None:
        entry = self.read(email)
        if not entry:
            return
        entry.last_used_at = int(time.time())
        self.write(entry)
