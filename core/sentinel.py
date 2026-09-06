"""OpenAI Sentinel token — pure-Python PoW (FNV-1a) cho `password/verify` + MFA.

Port 1:1 từ ``rust_upi_bot/src/auth/sentinel.rs`` — thuật toán FNV-1a với
post-mixing, config array 19 phần tử encoded base64, prefix ``gAAAAAB…~S``.

Anti-ban context: ChatGPT `password/verify` (auth.openai.com) yêu cầu 1
sentinel token trong header ``openai-sentinel-token`` — thiếu hoặc invalid
sẽ bị reject ngay hoặc silently drop OTP delivery. Token là 1 JSON dạng
``{"p": <b64_pow>, "t": "", "c": <challenge_token>, "id": <device_id>,
"flow": "login"}`` — trong đó ``p`` là **PoW proof** phải khớp difficulty
mà endpoint ``sentinel.openai.com/backend-api/sentinel/req`` cấp.

Flow:
    1. Sinh 1 ``requirements_token`` (b64 config array với nonce=1) — dùng
       cho POST ``/sentinel/req`` xin challenge.
    2. Nhận ``{token, proofofwork: {required, seed, difficulty}}`` từ server.
    3. Nếu ``required=true`` → chạy PoW nonce loop cho tới khi digest FNV-1a
       của ``seed + b64_config`` ≤ difficulty (hex compare).
    4. Đóng gói kết quả thành JSON token, trả về caller (chèn vào header
       ``openai-sentinel-token``).

Fail_Fast_Policy: `get_sentinel_token()` KHÔNG raise — mọi lỗi mạng/HTTP đều
fallback về requirements_token (không có `c`, không có `pow`) để caller vẫn
gọi được `password/verify` (server có thể vẫn accept khi anti-bot chưa strict,
hoặc reject → login flow trả `network_error` — có thông tin đầy đủ ở log
sentinel để debug).

_Requirements: 1.3, 1.4 — anti-ban prerequisite cho login flow._
"""

from __future__ import annotations

import base64
import json
import logging
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Final

# AsyncSession is duck-typed (curl_cffi.requests.AsyncSession)



# ---------------------------------------------------------------------------
# Constants — Sentinel endpoint + SDK URL (khớp UI ChatGPT hiện tại)
# ---------------------------------------------------------------------------

#: Endpoint xin challenge PoW từ Sentinel SDK.
_SENTINEL_REQ_URL: Final[str] = "https://sentinel.openai.com/backend-api/sentinel/req"

#: Referer khi POST `/sentinel/req` — bắt buộc trùng iframe origin.
_SENTINEL_REFERER: Final[str] = (
    "https://sentinel.openai.com/backend-api/sentinel/frame.html"
)

#: SDK build URL — được embed vào config array (index 5) làm signal.
_SENTINEL_SDK_URL: Final[str] = (
    "https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js"
)

#: Số nonce tối đa thử trong PoW loop — 500K là ngưỡng thực tế (thường
#: solve trong vài chục nghìn iteration với difficulty mặc định). Nếu vượt
#: → fallback token error prefix, caller vẫn dùng được nhưng server có thể
#: reject.
_MAX_POW_ATTEMPTS: Final[int] = 500_000

#: Error prefix chèn vào fallback token khi PoW vượt attempts.
_ERROR_PREFIX: Final[str] = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"

#: User-Agent embedded vào PoW config — PHẢI khớp UA curl_cffi gửi trên wire.
#: `curl_cffi` với ``impersonate="chrome136"`` set UA Chrome 136 macOS. Nếu
#: đổi `DEFAULT_IMPERSONATE` ở `http_client.py`, phải cập nhật hằng này
#: cùng lúc — OpenAI Sentinel verify UA embedded trong PoW payload khớp
#: với `User-Agent` wire, mismatch → reject request.
#:
#: Bump 2026-07-07: chrome131 → chrome136 (Cloudflare block fingerprint
#: chrome131 với cf-mitigated=challenge trên chatgpt.com).
_SENTINEL_UA: Final[str] = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)

#: Random pool cho index 11-13-17 của config array — port từ Rust.
_NAV_PROPS: Final[tuple[str, ...]] = (
    "vendorSub", "productSub", "vendor", "maxTouchPoints", "scheduling",
    "userActivation", "doNotTrack", "geolocation", "connection", "plugins",
    "mimeTypes", "pdfViewerEnabled", "webkitTemporaryStorage",
    "webkitPersistentStorage", "hardwareConcurrency", "cookieEnabled",
    "credentials", "mediaDevices", "permissions", "locks", "ink",
)
_CHOICE_12: Final[tuple[str, ...]] = (
    "location", "implementation", "URL", "documentURI", "compatMode",
)
_CHOICE_13: Final[tuple[str, ...]] = (
    "Object", "Function", "Array", "Number", "parseFloat", "undefined",
)
_CHOICE_17: Final[tuple[int, ...]] = (4, 8, 12, 16)


# ---------------------------------------------------------------------------
# Pure functions — FNV-1a + config builder
# ---------------------------------------------------------------------------


def _fnv1a_32(text: str) -> str:
    """FNV-1a 32-bit hash với post-mixing (khớp `sentinel_pow.py`).

    Args:
        text: Chuỗi input cần hash.

    Returns:
        8 hex digits (lowercase), zero-padded.
    """
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    # Post-mixing 3 rounds (mirror avalanche cải thiện distribution).
    h ^= h >> 16
    h = (h * 2246822507) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 3266489909) & 0xFFFFFFFF
    h ^= h >> 16
    return f"{h:08x}"


def _b64_encode_config(config: list[Any]) -> str:
    """Encode config array thành base64 JSON compact (separators=(",",":"))."""
    raw = json.dumps(config, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _build_config(user_agent: str) -> list[Any]:
    """Build config array 19 phần tử — mô phỏng browser fingerprint payload.

    Index layout (khớp Rust):
        0: screen resolution string
        1: current date string (JS toString-like)
        2: memory limit (fixed)
        3: nonce placeholder (0 tại đây, được set lại trong loop)
        4: user agent
        5: SDK URL
        6-7: null placeholders
        8-9: language + elapsed-ms placeholder
        10-13: random floats / nav prop / choice
        14: perf_now
        15: session uuid
        16: empty
        17: choice int
        18: time_origin
    """
    now = datetime.now(timezone.utc)
    # JS-style date: "Thu Jul 05 2026 11:00:00 GMT+0000 (Coordinated Universal Time)"
    date_str = now.strftime(
        "%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)"
    )
    perf_now = random.uniform(1000.0, 50000.0)
    time_origin = (now.timestamp() * 1000.0) - perf_now
    nav_prop = random.choice(_NAV_PROPS)
    sid = str(uuid.uuid4())

    return [
        "1920x1080",
        date_str,
        4_294_705_152,
        random.random(),  # [3] nonce placeholder
        user_agent,
        _SENTINEL_SDK_URL,
        None,
        None,
        "en-US",
        "en-US,en",  # [9] elapsed-ms placeholder
        random.random(),
        f"{nav_prop}\u2212undefined",
        random.choice(_CHOICE_12),
        random.choice(_CHOICE_13),
        perf_now,
        sid,
        "",
        random.choice(_CHOICE_17),
        time_origin,
    ]


def _solve_pow(seed: str, difficulty: str, user_agent: str) -> str:
    """Chạy PoW loop cho tới khi digest FNV-1a của (seed + b64_config) ≤ difficulty.

    Args:
        seed: Chuỗi seed từ challenge response.
        difficulty: Hex prefix (VD "00f") — digest phải ≤ prefix này.
        user_agent: UA embedded vào config.

    Returns:
        Token dạng ``gAAAAAB<b64_config>~S`` khi solve xong. Nếu vượt
        ``_MAX_POW_ATTEMPTS`` → fallback error token
        ``gAAAAAB<ERROR_PREFIX><b64('"None"')>``.
    """
    config = _build_config(user_agent)
    start = time.perf_counter()
    dlen = len(difficulty)

    for nonce in range(_MAX_POW_ATTEMPTS):
        config[3] = nonce
        config[9] = int((time.perf_counter() - start) * 1000)
        encoded = _b64_encode_config(config)
        digest = _fnv1a_32(seed + encoded)
        if dlen <= len(digest) and digest[:dlen] <= difficulty:
            return f"gAAAAAB{encoded}~S"

    # Fallback — server có thể reject nhưng vẫn tiếp tục flow.
    none_b64 = base64.b64encode(b'"None"').decode("ascii")
    return f"gAAAAAB{_ERROR_PREFIX}{none_b64}"


def _generate_requirements_token(user_agent: str) -> str:
    """Sinh requirements_token (prefix ``gAAAAAC``) cho POST `/sentinel/req`.

    Chỉ có nonce=1 + elapsed-ms randomized — KHÔNG chạy PoW loop.
    """
    config = _build_config(user_agent)
    config[3] = 1
    config[9] = int(random.uniform(5, 50))
    return f"gAAAAAC{_b64_encode_config(config)}"


# ---------------------------------------------------------------------------
# HTTP: xin challenge từ Sentinel
# ---------------------------------------------------------------------------


async def _fetch_challenge(
    http_client: Any,
    device_id: str,
    flow: str,
    request_p: str,
    logger: logging.Logger,
) -> dict[str, Any] | None:
    """POST `/sentinel/req` xin challenge PoW. `None` khi lỗi mạng/HTTP."""
    body = json.dumps({"p": request_p, "id": device_id, "flow": flow})
    headers = {
        "Accept": "*/*",
        "Referer": _SENTINEL_REFERER,
        "Origin": "https://sentinel.openai.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "text/plain;charset=UTF-8",
    }
    try:
        response = await http_client.post(
            _SENTINEL_REQ_URL, data=body, headers=headers
        )
    except (Exception, Exception, Exception) as exc:
        logger.info("[sentinel] /req transport error: %s", exc)
        return None

    if response.status_code != 200:
        logger.info("[sentinel] /req HTTP %s", response.status_code)
        return None

    try:
        return response.json()
    except ValueError as exc:
        logger.info("[sentinel] /req invalid JSON: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def get_sentinel_token(
    http_client: Any,
    device_id: str,
    flow: str,
    logger: logging.Logger,
) -> str:
    """Build sentinel token cho header `openai-sentinel-token`.

    LUÔN trả về String — không raise. Nếu fetch challenge fail hoặc PoW
    fallback → vẫn build token với `t=""`, `c=""` — caller không cần
    phân biệt success/fail (server tự quyết reject).

    Args:
        http_client: `curl_cffi.AsyncSession` đã config UA/proxy đầy đủ.
        device_id: Device ID (uuid) — có thể rỗng, sẽ tự sinh.
        flow: `"login"` hoặc `"password_verify"` — server phân biệt anti-bot
            heuristic theo flow.
        logger: Logger để log tiến trình PoW.

    Returns:
        JSON string dạng `{"p":..., "t":"", "c":..., "id":..., "flow":...}`.
    """
    did = device_id or str(uuid.uuid4())
    req_p = _generate_requirements_token(_SENTINEL_UA)

    challenge = await _fetch_challenge(http_client, did, flow, req_p, logger)
    if challenge is None:
        logger.info("[sentinel] challenge fetch failed → fallback token")
        return json.dumps(
            {"p": req_p, "t": "", "c": "", "id": did, "flow": flow}
        )

    c_value = (challenge.get("token") or "").strip()

    # Turnstile: the challenge carries an encrypted `dx`. Solve it via the ported Sentinel VM
    # (sentinel_vm.solve_turnstile_dx) to produce the real `t` value. A signup carrying a valid
    # solved `t` (instead of t="") is what stops OpenAI's async fraud review from deactivating
    # the account minutes later. XOR key = the requirements token we SENT (req_p), taken BEFORE
    # PoW overwrites p. Lazy import so a missing sentinel_vm.py degrades to t="" (old behaviour)
    # rather than breaking the whole login.
    t_value = ""
    dx_b64 = str((challenge.get("turnstile") or {}).get("dx") or "")
    if dx_b64:
        try:
            from sentinel_vm import solve_turnstile_dx
            t_value = solve_turnstile_dx(dx_b64, req_p, user_agent=_SENTINEL_UA, sdk_url=_SENTINEL_SDK_URL)
            logger.info("[sentinel] turnstile solved (t_len=%d) flow=%s", len(t_value), flow)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[sentinel] turnstile VM failed (flow=%s): %s", flow, exc)
    else:
        logger.info("[sentinel] no turnstile.dx in challenge (flow=%s) -> t stays empty", flow)

    pow_info = challenge.get("proofofwork") or {}
    required = bool(pow_info.get("required"))
    seed = pow_info.get("seed") or ""
    if required and seed:
        difficulty = pow_info.get("difficulty") or "0"
        p_value = _solve_pow(seed, difficulty, _SENTINEL_UA)
    else:
        p_value = req_p

    token = json.dumps(
        {"p": p_value, "t": t_value, "c": c_value, "id": did, "flow": flow}
    )
    logger.info("[sentinel] token built (len=%d, t_len=%d)", len(token), len(t_value))
    return token


__all__ = ["get_sentinel_token"]
