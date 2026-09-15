from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class AccountRecord(BaseModel):
    email: str
    password: str
    totp_secret: str


class SessionEntry(BaseModel):
    email: str
    cookies: dict[str, str]
    access_token: str
    expires_at: int
    created_at: int
    last_used_at: Optional[int] = None
    raw_session: dict[str, Any] = Field(default_factory=dict)


class SessionCacheEntry(BaseModel):
    email: str
    expires_at: int
    created_at: int
    last_used_at: Optional[int] = None
    file_size_bytes: int = 0
    is_expired: bool = False
