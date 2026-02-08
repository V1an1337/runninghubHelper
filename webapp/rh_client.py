from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

import requests


CREATE_URL = "https://www.runninghub.ai/task/webapp/create"
HISTORY_URL = "https://www.runninghub.ai/api/output/v2/history"
USERINFO_URL = "https://www.runninghub.ai/uc/getUserInfo"
ORIGIN = "https://www.runninghub.ai"


class StopRequested(RuntimeError):
    pass


def _sleep_with_stop(stop_event: Optional[threading.Event], seconds: float) -> None:
    if seconds <= 0:
        return
    end = time.monotonic() + seconds
    while True:
        if stop_event is not None and stop_event.is_set():
            raise StopRequested("stop requested")
        now = time.monotonic()
        if now >= end:
            return
        time.sleep(min(0.2, end - now))


@dataclass(frozen=True)
class ParsedAuth:
    host: str
    cookies: Dict[str, str]
    local_storage: Dict[str, str]


def parse_record(host: str, record: Dict[str, Any]) -> ParsedAuth:
    data = record.get("data")
    if not isinstance(data, list):
        data = []

    cookies: Dict[str, str] = {}
    local: Dict[str, str] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        typ = item.get("type")
        key = item.get("key")
        val = item.get("value")
        if not isinstance(typ, str) or not isinstance(key, str):
            continue
        if val is None:
            val = ""
        if not isinstance(val, str):
            val = str(val)

        t = typ.strip().lower()
        if t == "cookie":
            cookies[key] = val
        elif t == "localstorage":
            local[key] = val

    h = host.strip() if isinstance(host, str) and host.strip() else "www.runninghub.ai"
    return ParsedAuth(host=h, cookies=cookies, local_storage=local)


def extract_access_token(auth: ParsedAuth) -> str:
    for k in ("Rh-Accesstoken", "rh-accesstoken", "access_token", "token"):
        v = auth.local_storage.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    for k in ("Rh-Accesstoken", "rh-accesstoken", "access_token", "token"):
        v = auth.cookies.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def build_referer(payload: Dict[str, Any]) -> str:
    webapp_id = payload.get("webappId")
    if isinstance(webapp_id, str) and webapp_id.strip():
        return f"{ORIGIN}/ai-detail/{webapp_id.strip()}"
    return f"{ORIGIN}/"


def make_headers(token: str, referer: str) -> Dict[str, str]:
    h: Dict[str, str] = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "origin": ORIGIN,
        "referer": referer,
        "user-language": "zh_CN",
    }
    if token:
        h["authorization"] = f"Bearer {token}"
    return h


def install_cookies(session: requests.Session, auth: ParsedAuth) -> None:
    host = auth.host
    parent = ".runninghub.ai"
    for k, v in auth.cookies.items():
        try:
            session.cookies.set(k, v, domain=host, path="/")
            session.cookies.set(k, v, domain=parent, path="/")
        except Exception:
            pass


def get_user_info(
    session: requests.Session,
    token: str,
    user_id: str,
    *,
    referer: str = f"{ORIGIN}/",
    url: str = USERINFO_URL,
    timeout: float = 25.0,
) -> Dict[str, Any]:
    """
    POST /uc/getUserInfo with {userId}.

    This usually requires:
    - Authorization: Bearer <Rh-Accesstoken>
    - Cookies (credentials include)
    """
    body = {"userId": str(user_id)}
    headers = make_headers(token, referer)
    r = session.post(url, headers=headers, json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()


def create(
    session: requests.Session,
    payload: Dict[str, Any],
    token: str,
    url: str = CREATE_URL,
    timeout: float = 25.0,
) -> Dict[str, Any]:
    referer = build_referer(payload)
    headers = make_headers(token, referer)
    r = session.post(url, headers=headers, json=payload, timeout=timeout)
    r.raise_for_status()
    return r.json()


def history(
    session: requests.Session,
    token: str,
    referer: str,
    current: int = 1,
    size: int = 20,
    from_id: str = "",
    url: str = HISTORY_URL,
    timeout: float = 25.0,
) -> Dict[str, Any]:
    body = {"size": size, "current": current, "taskType": ["WORKFLOW", "WEBAPP"], "fromId": from_id}
    headers = make_headers(token, referer)
    r = session.post(url, headers=headers, json=body, timeout=timeout)
    r.raise_for_status()
    return r.json()


def extract_task_id(create_resp: Dict[str, Any]) -> str:
    data = create_resp.get("data")
    if isinstance(data, dict):
        tid = data.get("taskId") or data.get("task_id")
        return str(tid) if tid else ""
    tid = create_resp.get("taskId") or create_resp.get("task_id")
    return str(tid) if tid else ""


def is_task_complete(status: str) -> bool:
    s = (status or "").strip().upper()
    if not s:
        return False
    if s in {"RUNNING", "PENDING", "QUEUED", "WAITING", "PROCESSING"}:
        return False
    return True


def find_task_in_history(history_resp: Dict[str, Any], task_id: str) -> Optional[Dict[str, Any]]:
    data = history_resp.get("data")
    if not isinstance(data, list):
        return None
    for item in data:
        if not isinstance(item, dict):
            continue
        if str(item.get("taskId") or item.get("task_id") or "") == str(task_id):
            return item
    return None


def safe_filename(name: str) -> str:
    bad = '<>:"/\\|?*\0'
    out = "".join("_" if c in bad else c for c in name)
    out = out.strip().strip(".")
    return out or "output.bin"


def default_name_from_url(url: str) -> str:
    try:
        path = urlparse(url).path
        base = path.rsplit("/", 1)[-1] or "output.bin"
        return safe_filename(unquote(base))
    except Exception:
        return "output.bin"


def download_file(
    session: requests.Session,
    url: str,
    out_dir: Path,
    filename: str,
    timeout: float = 25.0,
    overwrite: bool = False,
    *,
    stop_event: Optional[threading.Event] = None,
    deadline_monotonic: Optional[float] = None,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / safe_filename(filename)
    if path.exists() and not overwrite:
        return path

    with session.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        tmp = path.with_suffix(path.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if stop_event is not None and stop_event.is_set():
                    raise StopRequested("stop requested")
                if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
                    raise TimeoutError("job timeout")
                if not chunk:
                    continue
                f.write(chunk)
        tmp.replace(path)
    return path


def wait_for_output(
    session: requests.Session,
    token: str,
    referer: str,
    task_id: str,
    *,
    history_pages: int = 3,
    history_size: int = 20,
    interval_sec: float = 3.0,
    timeout_sec: float = 600.0,
    history_url: str = HISTORY_URL,
    req_timeout: float = 25.0,
    stop_event: Optional[threading.Event] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    started = time.monotonic()
    last_status = ""

    while True:
        if stop_event is not None and stop_event.is_set():
            raise StopRequested("stop requested")

        if time.monotonic() - started > timeout_sec:
            return None, last_status

        hit: Optional[Dict[str, Any]] = None
        for page in range(1, max(1, history_pages) + 1):
            if stop_event is not None and stop_event.is_set():
                raise StopRequested("stop requested")
            try:
                h = history(
                    session,
                    token=token,
                    referer=referer,
                    current=page,
                    size=history_size,
                    from_id="",
                    url=history_url,
                    timeout=req_timeout,
                )
            except Exception:
                continue

            hit = find_task_in_history(h, task_id)
            if hit is not None:
                break

        if hit is None:
            _sleep_with_stop(stop_event, interval_sec)
            continue

        last_status = str(hit.get("taskStatus") or hit.get("status") or "")
        if is_task_complete(last_status):
            return hit, last_status

        _sleep_with_stop(stop_event, interval_sec)
