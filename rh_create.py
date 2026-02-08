#!/usr/bin/env python3
"""
RunningHub create requester (personal use).

Reads cookies/localStorage from a TokenMaster export (cookies.txt) and sends a POST
to https://www.runninghub.ai/task/webapp/create.

Notes:
- localStorage is NOT sent to the server; we only use it to *extract* token values.
- Cookies are sent via the HTTP Cookie header.
- Authorization is NOT automatically added by Python; you can opt-in via --token or
  let the script pick Rh-Accesstoken from localStorage/cookies.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse


CREATE_URL = "https://www.runninghub.ai/task/webapp/create"
HISTORY_URL = "https://www.runninghub.ai/api/output/v2/history"
ORIGIN = "https://www.runninghub.ai"


def _redact(value: str, keep: int = 6) -> str:
    if not value:
        return ""
    v = str(value)
    if len(v) <= keep:
        return "*" * len(v)
    return v[:keep] + "..." + v[-keep:]


def _load_json_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_payload(path: str) -> Dict[str, Any]:
    """
    Accept either:
    - a JSON object (preferred)
    - a JSON string which itself contains the object (rare)
    """
    raw = _load_json_file(path)
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            raise SystemExit(f"payload is a string but not valid JSON: {e}") from e
        if not isinstance(parsed, dict):
            raise SystemExit("payload must be a JSON object")
        return parsed
    raise SystemExit("payload must be a JSON object")


@dataclass(frozen=True)
class TokenDump:
    host: str
    cookies: Dict[str, str]
    local_storage: Dict[str, str]


def _parse_tokendump(path: str) -> TokenDump:
    """
    Supports the TokenMaster 'single record export' shape:
    {
      "schemaVersion": 1,
      "host": "www.runninghub.ai",
      "record": { "data": [ { "type": "Cookie"|"localStorage", "key": "...", "value": "..." } ] }
    }
    """
    root = _load_json_file(path)
    if not isinstance(root, dict):
        raise SystemExit("cookies.txt must be a JSON object")

    host = root.get("host") or root.get("hostname") or "www.runninghub.ai"
    if not isinstance(host, str) or not host.strip():
        host = "www.runninghub.ai"
    host = host.strip()

    record = root.get("record")
    if not isinstance(record, dict):
        raise SystemExit("cookies.txt missing 'record' object")
    data = record.get("data")
    if not isinstance(data, list):
        raise SystemExit("cookies.txt record missing 'data' array")

    cookies: Dict[str, str] = {}
    local_storage: Dict[str, str] = {}

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
            local_storage[key] = val

    return TokenDump(host=host, cookies=cookies, local_storage=local_storage)


def _extract_access_token(dump: TokenDump) -> str:
    # Prefer localStorage token, then cookie token.
    for k in ("Rh-Accesstoken", "rh-accesstoken", "access_token", "token"):
        if k in dump.local_storage and dump.local_storage[k].strip():
            return dump.local_storage[k].strip()
    for k in ("Rh-Accesstoken", "rh-accesstoken", "access_token", "token"):
        if k in dump.cookies and dump.cookies[k].strip():
            return dump.cookies[k].strip()
    return ""


def _build_referer(payload: Dict[str, Any], override: str) -> str:
    if override:
        return override
    webapp_id = payload.get("webappId")
    if isinstance(webapp_id, str) and webapp_id.strip():
        return f"{ORIGIN}/ai-detail/{webapp_id.strip()}"
    return f"{ORIGIN}/"


def _make_headers(payload: Dict[str, Any], token: str, referer: str) -> Dict[str, str]:
    h = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "origin": ORIGIN,
        "referer": referer,
        # From fetch.txt; server may ignore but harmless.
        "user-language": "zh_CN",
    }
    if token:
        h["authorization"] = f"Bearer {token}"
    return h


def _make_history_body(size: int, current: int, from_id: str) -> Dict[str, Any]:
    return {
        "size": size,
        "current": current,
        "taskType": ["WORKFLOW", "WEBAPP"],
        "fromId": from_id or "",
    }


def _extract_task_id(create_resp: Any) -> str:
    if not isinstance(create_resp, dict):
        return ""
    data = create_resp.get("data")
    if isinstance(data, dict):
        tid = data.get("taskId") or data.get("task_id")
        return str(tid) if tid else ""
    # Sometimes servers return taskId at top-level
    tid = create_resp.get("taskId") or create_resp.get("task_id")
    return str(tid) if tid else ""


def _is_task_complete(status: str) -> bool:
    s = (status or "").strip().upper()
    if not s:
        return False
    # RunningHub commonly uses SUCCESS/FAILED/RUNNING.
    if s in {"RUNNING", "PENDING", "QUEUED", "WAITING", "PROCESSING"}:
        return False
    return True


def _find_task_in_history(history_resp: Any, task_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(history_resp, dict):
        return None
    data = history_resp.get("data")
    if not isinstance(data, list):
        return None
    for item in data:
        if not isinstance(item, dict):
            continue
        if str(item.get("taskId") or item.get("task_id") or "") == str(task_id):
            return item
    return None


def _safe_filename(name: str) -> str:
    # Keep it simple and Windows-friendly.
    bad = '<>:"/\\|?*\0'
    out = "".join("_" if c in bad else c for c in name)
    out = out.strip().strip(".")
    return out or "output.bin"


def _default_name_from_url(url: str) -> str:
    try:
        path = urlparse(url).path
        base = path.rsplit("/", 1)[-1] or "output.bin"
        return _safe_filename(unquote(base))
    except Exception:
        return "output.bin"


def _download_file(session: Any, url: str, out_dir: Path, filename: str, overwrite: bool, timeout: float) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / _safe_filename(filename)
    if path.exists() and not overwrite:
        return path

    with session.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        tmp = path.with_suffix(path.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if not chunk:
                    continue
                f.write(chunk)
        tmp.replace(path)
    return path


def _install_cookies(session: Any, dump: TokenDump) -> None:
    # The dump does not preserve cookie domain/path; set for both host and parent domain.
    host = dump.host
    parent = ".runninghub.ai"
    for k, v in dump.cookies.items():
        try:
            session.cookies.set(k, v, domain=host, path="/")
            session.cookies.set(k, v, domain=parent, path="/")
        except Exception:
            # Best-effort; requests will still send host cookies if possible.
            pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cookies", default="cookies.txt", help="TokenMaster export JSON (default: cookies.txt)")
    ap.add_argument("--payload", required=True, help="create payload JSON file (object), e.g. create_payload.json")
    ap.add_argument("--url", default=CREATE_URL, help=f"create endpoint URL (default: {CREATE_URL})")
    ap.add_argument("--referer", default="", help="override Referer header (default: derived from payload.webappId)")
    ap.add_argument("--token", default="", help="override Authorization token (Bearer ... without Bearer)")
    ap.add_argument("--no-auth", action="store_true", help="do not send Authorization even if token is available")
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--out", default="", help="write response JSON/text to this file")
    ap.add_argument("--no-history", action="store_true", help="do not poll history after create")
    ap.add_argument("--history-url", default=HISTORY_URL, help=f"history endpoint URL (default: {HISTORY_URL})")
    ap.add_argument("--history-interval", type=float, default=3.0, help="poll interval seconds (default: 3)")
    ap.add_argument("--history-timeout", type=float, default=600.0, help="max wait seconds (default: 600)")
    ap.add_argument("--history-pages", type=int, default=3, help="pages to scan per poll (default: 3)")
    ap.add_argument("--history-size", type=int, default=20, help="page size (default: 20)")
    ap.add_argument("--no-download", action="store_true", help="do not download output file even if available")
    ap.add_argument("--download-dir", default="downloads", help="output download dir (default: downloads)")
    ap.add_argument("--overwrite", action="store_true", help="overwrite existing downloaded file")
    ap.add_argument("--dry-run", action="store_true", help="print request summary but do not send")
    args = ap.parse_args(argv)

    dump = _parse_tokendump(args.cookies)
    payload = _load_payload(args.payload)

    token = args.token.strip() or os.environ.get("RH_ACCESS_TOKEN", "").strip() or _extract_access_token(dump)
    if args.no_auth:
        token = ""

    referer = _build_referer(payload, args.referer.strip())
    headers = _make_headers(payload, token, referer)

    try:
        import requests  # type: ignore
    except Exception as e:
        raise SystemExit("missing dependency: requests. Install with: pip install requests") from e

    s = requests.Session()
    _install_cookies(s, dump)

    # Minimal visibility without leaking secrets.
    print(f"[rh_create] host={dump.host}")
    print(f"[rh_create] url={args.url}")
    print(f"[rh_create] referer={referer}")
    print(f"[rh_create] auth={'yes' if 'authorization' in headers else 'no'} token={_redact(token)}")
    print(f"[rh_create] cookies={len(dump.cookies)} localStorage={len(dump.local_storage)}")
    print(f"[rh_create] payload.webappId={payload.get('webappId')!r}")

    if args.dry_run:
        print("[rh_create] dry-run: not sending request")
        return 0

    resp = s.post(args.url, headers=headers, json=payload, timeout=args.timeout)
    ct = resp.headers.get("content-type", "")

    text = resp.text
    data: Any = None
    if "application/json" in ct.lower():
        try:
            data = resp.json()
        except Exception:
            data = None

    print(f"[rh_create] status={resp.status_code} content-type={ct!r}")
    if data is not None:
        # Print only top-level keys to avoid huge output.
        keys = list(data.keys()) if isinstance(data, dict) else None
        print(f"[rh_create] json_keys={keys}")
    else:
        print(f"[rh_create] body_prefix={text[:300]!r}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            if data is not None:
                json.dump(data, f, ensure_ascii=False, indent=2)
            else:
                f.write(text)
        print(f"[rh_create] wrote response to {args.out}")

    # Poll history and optionally download output file.
    if not args.no_history and data is not None:
        task_id = _extract_task_id(data)
        if not task_id:
            print("[rh_create] history: no taskId found in create response; skip")
            return 0

        print(f"[rh_create] history: taskId={task_id}")
        started = time.time()
        last_status = ""
        found_any = False

        while True:
            elapsed = time.time() - started
            if elapsed > float(args.history_timeout):
                print(f"[rh_create] history: timeout after {args.history_timeout}s (last_status={last_status!r}, found={found_any})")
                break

            hit: Optional[Dict[str, Any]] = None
            for page in range(1, max(1, int(args.history_pages)) + 1):
                body = _make_history_body(int(args.history_size), page, "")
                h_headers = _make_headers(payload, token, referer)
                h_resp = s.post(args.history_url, headers=h_headers, json=body, timeout=args.timeout)
                h_ct = h_resp.headers.get("content-type", "")
                if "application/json" not in h_ct.lower():
                    continue
                try:
                    h_json = h_resp.json()
                except Exception:
                    continue

                hit = _find_task_in_history(h_json, task_id)
                if hit is not None:
                    break

            if hit is None:
                time.sleep(float(args.history_interval))
                continue

            found_any = True
            last_status = str(hit.get("taskStatus") or hit.get("status") or "")
            file_url = str(hit.get("fileUrl") or hit.get("file_url") or "") if hit.get("fileUrl") or hit.get("file_url") else ""
            output_name = str(hit.get("outputName") or hit.get("output_name") or "") if hit.get("outputName") or hit.get("output_name") else ""

            print(f"[rh_create] history: status={last_status!r} fileUrl={'yes' if file_url else 'no'}")

            if _is_task_complete(last_status):
                if file_url and not args.no_download:
                    filename = output_name.strip() or _default_name_from_url(file_url)
                    out_dir = Path(args.download_dir)
                    try:
                        path = _download_file(s, file_url, out_dir, filename, bool(args.overwrite), float(args.timeout))
                        print(f"[rh_create] downloaded: {path}")
                    except Exception as e:
                        print(f"[rh_create] download failed: {e}")
                break

            time.sleep(float(args.history_interval))

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
