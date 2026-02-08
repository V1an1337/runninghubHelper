from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import mimetypes
from urllib.parse import quote
from fastapi import Body, FastAPI, HTTPException
from fastapi import File, Form, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import rh_client
from .storage import read_json, write_json


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DOWNLOAD_DIR = ROOT / "downloads"
RESOURCE_FILES_DIR = ROOT / "resource_files"

TEMPLATES_PATH = DATA_DIR / "templates.json"
COOKIES_PATH = DATA_DIR / "cookies.json"
RESOURCES_PATH = DATA_DIR / "resources.json"
SETTINGS_PATH = DATA_DIR / "settings.json"


DATA_DIR.mkdir(parents=True, exist_ok=True)
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
RESOURCE_FILES_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="TokenMaster Web", version="0.1")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/downloads", StaticFiles(directory=str(DOWNLOAD_DIR)), name="downloads")
app.mount("/resource-files", StaticFiles(directory=str(RESOURCE_FILES_DIR)), name="resource-files")


MAX_CONCURRENT_JOBS = 6
_job_slots = threading.Semaphore(MAX_CONCURRENT_JOBS)
_shutdown_event = threading.Event()
_jobs_lock = threading.Lock()
_jobs: Dict[str, Dict[str, Any]] = {}


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _gen_id() -> str:
    return uuid.uuid4().hex


def _mtime_iso(path: Path) -> str:
    try:
        st = path.stat()
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))
    except Exception:
        return _now_iso()

def _coerce_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        if isinstance(v, bool):
            return default
        return int(v)
    except Exception:
        return default


def _default_settings() -> Dict[str, Any]:
    return {
        "schemaVersion": 1,
        # Total wall time per job (create + poll history + download + unzip).
        "jobTimeoutSec": 600,
        # History polling interval.
        "historyIntervalSec": 3.0,
        # Per-request timeout for create/history/download.
        "requestTimeoutSec": 25.0,
    }


def _load_settings() -> Dict[str, Any]:
    base = _default_settings()
    raw = read_json(SETTINGS_PATH, {})
    if isinstance(raw, dict):
        base.update(raw)

    # Validate/coerce
    try:
        base["jobTimeoutSec"] = int(base.get("jobTimeoutSec", 600))
    except Exception:
        base["jobTimeoutSec"] = 600
    base["jobTimeoutSec"] = max(30, min(24 * 3600, base["jobTimeoutSec"]))

    try:
        base["historyIntervalSec"] = float(base.get("historyIntervalSec", 3.0))
    except Exception:
        base["historyIntervalSec"] = 3.0
    base["historyIntervalSec"] = max(0.5, min(60.0, base["historyIntervalSec"]))

    try:
        base["requestTimeoutSec"] = float(base.get("requestTimeoutSec", 25.0))
    except Exception:
        base["requestTimeoutSec"] = 25.0
    base["requestTimeoutSec"] = max(3.0, min(120.0, base["requestTimeoutSec"]))

    return base


def _save_settings(next_settings: Dict[str, Any]) -> Dict[str, Any]:
    merged = _load_settings()
    if isinstance(next_settings, dict):
        for k in ("jobTimeoutSec", "historyIntervalSec", "requestTimeoutSec"):
            if k in next_settings:
                merged[k] = next_settings[k]
    write_json(SETTINGS_PATH, merged)
    return _load_settings()


@app.on_event("shutdown")
def _on_shutdown() -> None:
    # Let background job threads stop quickly on Ctrl+C / uvicorn shutdown.
    _shutdown_event.set()


def _safe_extract_zip(zip_path: Path, dest_dir: Path) -> List[Path]:
    """
    Extract zip to dest_dir, preventing zip-slip. Returns extracted file paths.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    extracted: List[Path] = []
    base = dest_dir.resolve()

    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            name = info.filename
            if not name or name.endswith("/"):
                continue

            target = (dest_dir / name)
            try:
                resolved = target.resolve()
            except Exception:
                continue

            if not str(resolved).startswith(str(base)):
                continue

            resolved.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as src, open(resolved, "wb") as out:
                out.write(src.read())
            extracted.append(resolved)

    return extracted


def _load_templates() -> List[Dict[str, Any]]:
    data = read_json(TEMPLATES_PATH, {"schemaVersion": 1, "templates": []})
    if isinstance(data, dict) and isinstance(data.get("templates"), list):
        return [t for t in data["templates"] if isinstance(t, dict)]
    if isinstance(data, list):
        return [t for t in data if isinstance(t, dict)]
    return []


def _save_templates(templates: List[Dict[str, Any]]) -> None:
    write_json(TEMPLATES_PATH, {"schemaVersion": 1, "templates": templates})


def _load_cookies() -> List[Dict[str, Any]]:
    data = read_json(COOKIES_PATH, {"schemaVersion": 1, "profiles": []})
    if isinstance(data, dict) and isinstance(data.get("profiles"), list):
        return [p for p in data["profiles"] if isinstance(p, dict)]
    if isinstance(data, list):
        return [p for p in data if isinstance(p, dict)]
    return []


def _save_cookies(profiles: List[Dict[str, Any]]) -> None:
    write_json(COOKIES_PATH, {"schemaVersion": 1, "profiles": profiles})


def _load_resources() -> List[Dict[str, Any]]:
    data = read_json(RESOURCES_PATH, {"schemaVersion": 1, "resources": []})
    if isinstance(data, dict) and isinstance(data.get("resources"), list):
        return [r for r in data["resources"] if isinstance(r, dict)]
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    return []


def _save_resources(resources: List[Dict[str, Any]]) -> None:
    write_json(RESOURCES_PATH, {"schemaVersion": 1, "resources": resources})


def _extract_kv_from_record(record: Dict[str, Any], key: str) -> str:
    data = record.get("data")
    if not isinstance(data, list):
        return ""
    for item in data:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "").strip().lower() != "localstorage":
            continue
        if item.get("key") == key and isinstance(item.get("value"), str) and item["value"].strip():
            return item["value"].strip()
    for item in data:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "").strip().lower() != "cookie":
            continue
        if item.get("key") == key and isinstance(item.get("value"), str) and item["value"].strip():
            return item["value"].strip()
    return ""


def _extract_user_info_from_record(record: Dict[str, Any]) -> Dict[str, Any]:
    raw = _extract_kv_from_record(record, "userInfo")
    if not raw:
        return {}
    try:
        j = json.loads(raw)
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def _extract_user_id_from_record(record: Dict[str, Any]) -> str:
    ui = _extract_user_info_from_record(record)
    uid = ui.get("id")
    return str(uid).strip() if uid else ""


def _extract_total_coin_from_user_info(ui: Dict[str, Any]) -> str:
    if not isinstance(ui, dict):
        return ""
    v = ui.get("totalCoin")
    if v is None:
        return ""
    s = str(v).strip()
    return s


def _normalize_resource(r: Dict[str, Any]) -> Dict[str, Any]:
    rid = r.get("id")
    if not isinstance(rid, str) or not rid.strip():
        rid = _gen_id()

    name = r.get("name")
    if not isinstance(name, str) or not name.strip():
        name = ""

    now = _now_iso()
    created_at = r.get("createdAt") if isinstance(r.get("createdAt"), str) else now
    updated_at = now

    return {
        "id": str(rid),
        "name": str(name),
        "originalFilename": str(r.get("originalFilename") or ""),
        "webappId": str(r.get("webappId") or ""),
        "profileId": str(r.get("profileId") or ""),
        "profileName": str(r.get("profileName") or ""),
        "uploadResponse": r.get("uploadResponse") if isinstance(r.get("uploadResponse"), dict) else {},
        # Local copy (for inline preview in web UI).
        "localPath": str(r.get("localPath") or ""),
        "localUrl": str(r.get("localUrl") or ""),
        "mime": str(r.get("mime") or ""),
        "size": _coerce_int(r.get("size"), 0),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def _normalize_template(t: Dict[str, Any]) -> Dict[str, Any]:
    payload = t.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}

    webapp_id = t.get("webappId")
    if not isinstance(webapp_id, str) or not webapp_id.strip():
        w = payload.get("webappId")
        webapp_id = w if isinstance(w, str) else ""
    webapp_id = webapp_id.strip() if isinstance(webapp_id, str) else ""

    name = t.get("name")
    if not isinstance(name, str) or not name.strip():
        name = f"模板 {webapp_id}" if webapp_id else f"模板 {_now_iso()}"

    referer = t.get("referer")
    if not isinstance(referer, str) or not referer.strip():
        referer = rh_client.build_referer(payload)

    tid = t.get("id")
    if not isinstance(tid, str) or not tid.strip():
        tid = _gen_id()

    now = _now_iso()
    created_at = t.get("createdAt") if isinstance(t.get("createdAt"), str) else now
    updated_at = now

    return {
        "id": tid,
        "name": name.strip(),
        "webappId": webapp_id,
        "referer": referer,
        "payload": payload,
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def _normalize_cookie_profile(host: str, record: Dict[str, Any]) -> Dict[str, Any]:
    h = host.strip() if isinstance(host, str) and host.strip() else "www.runninghub.ai"
    rec = record if isinstance(record, dict) else {}
    name = rec.get("name")
    if not isinstance(name, str) or not name.strip():
        # tokenmaster records usually have name; fallback to record id.
        rid = rec.get("id")
        name = str(rid) if rid else "cookie"

    pid = _gen_id()
    now = _now_iso()
    ui = _extract_user_info_from_record(rec)
    user_id = _extract_user_id_from_record(rec)
    total_coin = _extract_total_coin_from_user_info(ui)
    return {
        "id": pid,
        "host": h,
        "name": name.strip(),
        "userId": user_id,
        "totalCoin": total_coin,
        "userInfoUpdatedAt": "",
        "record": rec,
        "createdAt": now,
        "updatedAt": now,
    }


def _get_job(job_id: str) -> Dict[str, Any]:
    with _jobs_lock:
        j = _jobs.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="job not found")
        return j


@app.get("/", response_class=HTMLResponse)
def index() -> Any:
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/api/downloads")
def list_downloads() -> Any:
    """
    List files under webapp/downloads for the "下载" tab.
    """
    items: List[Dict[str, Any]] = []
    try:
        if not DOWNLOAD_DIR.exists():
            return {"ok": True, "items": []}

        for p in DOWNLOAD_DIR.rglob("*"):
            try:
                if not p.is_file():
                    continue
                rel = p.resolve().relative_to(DOWNLOAD_DIR.resolve()).as_posix()
                st = p.stat()
                ext = p.suffix.lower()
                mime, _ = mimetypes.guess_type(p.name)
                items.append(
                    {
                        "path": rel,
                        "name": p.name,
                        "ext": ext,
                        "size": int(st.st_size),
                        "modifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                        "url": "/downloads/" + rel,
                        "mime": mime or "",
                    }
                )
            except Exception:
                continue
    except Exception:
        items = []

    items.sort(key=lambda x: x.get("modifiedAt", ""), reverse=True)
    return {"ok": True, "items": items}


@app.get("/api/settings")
def get_settings() -> Any:
    return {"ok": True, "settings": _load_settings()}


@app.put("/api/settings")
def put_settings(body: Dict[str, Any] = Body(...)) -> Any:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="settings must be an object")
    return {"ok": True, "settings": _save_settings(body)}


# ---------------- Templates ----------------

@app.get("/api/templates")
def list_templates() -> Any:
    return {"ok": True, "templates": _load_templates()}


@app.post("/api/templates")
def create_template(body: Dict[str, Any] = Body(...)) -> Any:
    templates = _load_templates()
    t = _normalize_template(body)
    templates = [x for x in templates if x.get("id") != t["id"]]
    templates.insert(0, t)
    _save_templates(templates)
    return {"ok": True, "template": t}


@app.put("/api/templates/{template_id}")
def update_template(template_id: str, body: Dict[str, Any] = Body(...)) -> Any:
    templates = _load_templates()
    idx = next((i for i, x in enumerate(templates) if x.get("id") == template_id), -1)
    if idx < 0:
        raise HTTPException(status_code=404, detail="template not found")

    merged = dict(templates[idx])
    merged.update(body)
    merged["id"] = template_id
    t = _normalize_template(merged)
    templates[idx] = t
    _save_templates(templates)
    return {"ok": True, "template": t}


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str) -> Any:
    templates = _load_templates()
    next_list = [x for x in templates if x.get("id") != template_id]
    _save_templates(next_list)
    return {"ok": True}


@app.post("/api/templates/import")
def import_templates(payload: Any = Body(...)) -> Any:
    # Accept: {templates:[...]} or [...] or single template object
    incoming: List[Dict[str, Any]] = []
    if isinstance(payload, dict) and isinstance(payload.get("templates"), list):
        incoming = [x for x in payload["templates"] if isinstance(x, dict)]
    elif isinstance(payload, list):
        incoming = [x for x in payload if isinstance(x, dict)]
    elif isinstance(payload, dict):
        incoming = [payload]

    templates = _load_templates()
    by_id = {str(t.get("id")): t for t in templates if isinstance(t.get("id"), str)}

    added = 0
    for raw in incoming:
        t = _normalize_template(raw)
        by_id[t["id"]] = t
        added += 1

    merged = list(by_id.values())
    merged.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
    _save_templates(merged)
    return {"ok": True, "count": len(merged), "imported": added}


@app.get("/api/templates/export")
def export_templates() -> Any:
    return {"schemaVersion": 1, "templates": _load_templates()}


# ---------------- Cookies ----------------

@app.get("/api/cookies")
def list_cookies() -> Any:
    out: List[Dict[str, Any]] = []
    for p in _load_cookies():
        q = dict(p)
        rec = q.get("record")
        if isinstance(rec, dict):
            if not isinstance(q.get("userId"), str) or not str(q.get("userId") or "").strip():
                q["userId"] = _extract_user_id_from_record(rec)
            if not isinstance(q.get("totalCoin"), str) or not str(q.get("totalCoin") or "").strip():
                ui = _extract_user_info_from_record(rec)
                q["totalCoin"] = _extract_total_coin_from_user_info(ui)
        out.append(q)
    return {"ok": True, "profiles": out}


@app.delete("/api/cookies/{profile_id}")
def delete_cookie(profile_id: str) -> Any:
    profiles = _load_cookies()
    next_list = [x for x in profiles if x.get("id") != profile_id]
    _save_cookies(next_list)
    return {"ok": True}


@app.post("/api/cookies/import")
def import_cookies(payload: Any = Body(...)) -> Any:
    """
    Supports:
    - cookies.txt (single): { host, record: {...} }
    - multicookies.txt (multi): { records: { host: [record, ...] } }
    - bare multi root: { "www.runninghub.ai": [record, ...] }
    """
    profiles = _load_cookies()
    added = 0

    def add_one(host: str, record: Dict[str, Any]) -> None:
        nonlocal profiles, added
        p = _normalize_cookie_profile(host, record)
        profiles.insert(0, p)
        added += 1

    if isinstance(payload, dict) and isinstance(payload.get("record"), dict):
        host = payload.get("host") or payload.get("hostname") or "www.runninghub.ai"
        add_one(str(host), payload["record"])
    else:
        root = payload
        if isinstance(payload, dict) and isinstance(payload.get("records"), dict):
            root = payload["records"]

        if isinstance(root, dict):
            for host, recs in root.items():
                if not isinstance(recs, list):
                    continue
                for r in recs:
                    if isinstance(r, dict):
                        add_one(str(host), r)

    _save_cookies(profiles)
    return {"ok": True, "added": added, "count": len(profiles)}


@app.get("/api/cookies/export")
def export_cookies() -> Any:
    # Export as multi-records shape (multicookies.txt).
    profiles = _load_cookies()
    out: Dict[str, List[Dict[str, Any]]] = {}
    for p in profiles:
        host = p.get("host")
        record = p.get("record")
        if not isinstance(host, str) or not isinstance(record, dict):
            continue
        out.setdefault(host, []).append(record)
    return {"schemaVersion": 1, "records": out}


# ---------------- User Info ----------------

def _update_cookie_profile_fields(profile_id: str, **fields: Any) -> Dict[str, Any]:
    profiles = _load_cookies()
    idx = next((i for i, p in enumerate(profiles) if p.get("id") == profile_id), -1)
    if idx < 0:
        raise HTTPException(status_code=404, detail="cookie profile not found")
    next_p = dict(profiles[idx])
    next_p.update(fields)
    next_p["updatedAt"] = _now_iso()
    profiles[idx] = next_p
    _save_cookies(profiles)
    return next_p


@app.post("/api/getUserInfo")
def get_user_info(body: Dict[str, Any] = Body(...)) -> Any:
    """
    Call RunningHub /uc/getUserInfo for a cookie profile and persist totalCoin.
    """
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="invalid body")
    profile_id = body.get("profileId")
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise HTTPException(status_code=400, detail="profileId required")

    profiles = _load_cookies()
    profile = next((p for p in profiles if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail="cookie profile not found")

    host = str(profile.get("host") or "www.runninghub.ai")
    record = profile.get("record")
    if not isinstance(record, dict):
        raise HTTPException(status_code=400, detail="cookie record invalid")

    # userId comes from record.localStorage.userInfo.id by default.
    user_id = body.get("userId") if isinstance(body.get("userId"), str) else ""
    user_id = user_id.strip() if user_id else ""
    if not user_id:
        user_id = str(profile.get("userId") or "").strip()
    if not user_id:
        user_id = _extract_user_id_from_record(record)
    if not user_id:
        raise HTTPException(status_code=400, detail="missing userId (record.localStorage.userInfo.id)")

    auth = rh_client.parse_record(host, record)
    token = rh_client.extract_access_token(auth)

    # Best-effort request; auth token is usually required, but cookies may also be needed.
    session = requests.Session()
    rh_client.install_cookies(session, auth)

    settings = _load_settings()
    try:
        req_timeout = float(settings.get("requestTimeoutSec", 25.0))
    except Exception:
        req_timeout = 25.0

    try:
        resp = rh_client.get_user_info(session, token=token, user_id=user_id, referer=f"{rh_client.ORIGIN}/", timeout=req_timeout)
    except requests.HTTPError as e:
        try:
            msg = f"{e}"
            if getattr(e, "response", None) is not None:
                msg = f"{msg}: {e.response.status_code} {e.response.text}"
        except Exception:
            msg = str(e)
        raise HTTPException(status_code=502, detail=msg)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Parse totalCoin from response.data.totalCoin
    total_coin = ""
    if isinstance(resp, dict):
        data = resp.get("data")
        if isinstance(data, dict):
            total_coin = str(data.get("totalCoin") or "").strip()

    next_p = _update_cookie_profile_fields(
        profile_id,
        userId=user_id,
        totalCoin=total_coin,
        userInfoUpdatedAt=_now_iso(),
    )
    return {"ok": True, "profile": next_p, "userId": user_id, "totalCoin": total_coin}


@app.post("/api/cookies/{profile_id}/getUserInfo")
def get_user_info_by_id(profile_id: str) -> Any:
    # Convenience alias for the UI.
    return get_user_info({"profileId": profile_id})


# ---------------- Resources ----------------

@app.get("/api/resources")
def list_resources() -> Any:
    resources = _load_resources()
    resources.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    return {"ok": True, "resources": resources}


@app.delete("/api/resources/{resource_id}")
def delete_resource(resource_id: str) -> Any:
    resources = _load_resources()
    victim = next((r for r in resources if r.get("id") == resource_id), None)
    next_list = [r for r in resources if r.get("id") != resource_id]
    _save_resources(next_list)
    try:
        lp = victim.get("localPath") if isinstance(victim, dict) else ""
        if isinstance(lp, str) and lp.strip():
            p = (RESOURCE_FILES_DIR / lp.strip())
            if p.exists() and p.is_file():
                p.unlink(missing_ok=True)
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/resources/export")
def export_resources() -> Any:
    return {"schemaVersion": 1, "resources": _load_resources()}


@app.post("/api/resources/import")
def import_resources(payload: Any = Body(...)) -> Any:
    incoming: List[Dict[str, Any]] = []
    if isinstance(payload, dict) and isinstance(payload.get("resources"), list):
        incoming = [x for x in payload["resources"] if isinstance(x, dict)]
    elif isinstance(payload, list):
        incoming = [x for x in payload if isinstance(x, dict)]
    elif isinstance(payload, dict):
        incoming = [payload]

    resources = _load_resources()
    by_id = {str(r.get("id")): r for r in resources if isinstance(r.get("id"), str)}
    added = 0
    for raw in incoming:
        nr = _normalize_resource(raw)
        by_id[nr["id"]] = nr
        added += 1

    merged = list(by_id.values())
    merged.sort(key=lambda r: r.get("updatedAt", ""), reverse=True)
    _save_resources(merged)
    return {"ok": True, "count": len(merged), "imported": added}


@app.post("/api/resources/upload")
def upload_resource(
    profileId: str = Form(...),
    file: UploadFile = File(...),
    webappId: str = Form(""),
) -> Any:
    """
    Upload any file to RunningHub upload API (per upload.txt).

    RunningHub expects:
    - POST https://www.runninghub.ai/upload/image?Rh-Comfy-Auth=...&Rh-Identify=...
    - multipart field name "image"
    """
    profiles = _load_cookies()
    profile = next((p for p in profiles if p.get("id") == profileId), None)
    if not profile:
        raise HTTPException(status_code=404, detail="cookie profile not found")

    host = str(profile.get("host") or "www.runninghub.ai")
    record = profile.get("record")
    if not isinstance(record, dict):
        raise HTTPException(status_code=400, detail="cookie record invalid")

    auth = rh_client.parse_record(host, record)
    token = rh_client.extract_access_token(auth)

    comfy_auth = _extract_kv_from_record(record, "Rh-Comfy-Auth")
    identify = _extract_kv_from_record(record, "Rh-Identify")
    if not comfy_auth or not identify:
        raise HTTPException(status_code=400, detail="missing Rh-Comfy-Auth or Rh-Identify in record.localStorage")

    # Build upload url and headers (both query and headers are used by browser).
    upload_url = f"https://www.runninghub.ai/upload/image?Rh-Comfy-Auth={quote(comfy_auth, safe='')}&Rh-Identify={quote(identify, safe='')}"
    referer = f"{rh_client.ORIGIN}/ai-detail/{webappId}" if webappId else f"{rh_client.ORIGIN}/"
    headers = rh_client.make_headers(token=token, referer=referer)
    # Let requests set correct multipart Content-Type.
    headers.pop("content-type", None)
    headers["rh-comfy-auth"] = comfy_auth
    headers["rh-identify"] = identify

    session = requests.Session()
    rh_client.install_cookies(session, auth)

    content_type = file.content_type or "application/octet-stream"
    # requests will generate the multipart boundary for us.
    resp = session.post(
        upload_url,
        headers=headers,
        files={"image": (file.filename or "file.bin", file.file, content_type)},
        timeout=60.0,
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    try:
        out = resp.json()
    except Exception:
        raise HTTPException(status_code=500, detail="upload response not json")

    name = out.get("name") if isinstance(out, dict) else None
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=500, detail="upload response missing name")

    # Save a local copy for inline preview in the "资源库" tab.
    local_path = ""
    local_url = ""
    local_size = 0
    local_mime = file.content_type or ""
    try:
        safe_name = rh_client.safe_filename(name.strip())
        dest = RESOURCE_FILES_DIR / safe_name
        try:
            file.file.seek(0)
        except Exception:
            pass
        with open(dest, "wb") as out_f:
            shutil.copyfileobj(file.file, out_f, length=1024 * 1024)
        try:
            local_size = int(dest.stat().st_size)
        except Exception:
            local_size = 0
        if not local_mime:
            local_mime = mimetypes.guess_type(dest.name)[0] or ""
        local_path = dest.name
        local_url = "/resource-files/" + dest.name
    except Exception:
        # Local copy is a best-effort feature; upload still succeeds without it.
        local_path = ""
        local_url = ""
        local_size = 0

    resources = _load_resources()
    # Deduplicate by name.
    existing_idx = next((i for i, r in enumerate(resources) if r.get("name") == name), -1)
    now = _now_iso()
    res = {
        "id": resources[existing_idx]["id"] if existing_idx >= 0 and isinstance(resources[existing_idx].get("id"), str) else _gen_id(),
        "name": name,
        "originalFilename": file.filename or "",
        "webappId": webappId or "",
        "profileId": profileId,
        "profileName": str(profile.get("name") or ""),
        "uploadResponse": out if isinstance(out, dict) else {},
        "localPath": local_path,
        "localUrl": local_url,
        "mime": local_mime,
        "size": local_size,
        "createdAt": resources[existing_idx].get("createdAt", now) if existing_idx >= 0 else now,
        "updatedAt": now,
    }

    if existing_idx >= 0:
        resources[existing_idx] = res
    else:
        resources.insert(0, res)
    _save_resources(resources)

    return {"ok": True, "resource": res}


# ---------------- Jobs ----------------

@app.get("/api/jobs")
def list_jobs() -> Any:
    with _jobs_lock:
        jobs = list(_jobs.values())
    jobs.sort(key=lambda j: j.get("createdAt", ""), reverse=True)
    return {"ok": True, "jobs": jobs}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Any:
    return {"ok": True, "job": _get_job(job_id)}


@app.post("/api/jobs")
def start_job(body: Dict[str, Any] = Body(...)) -> Any:
    template_id = body.get("templateId")
    profile_id = body.get("profileId")
    payload_override = body.get("payload")

    no_auth = bool(body.get("noAuth", False))
    token_override = body.get("token") if isinstance(body.get("token"), str) else ""

    if not isinstance(template_id, str) or not template_id:
        raise HTTPException(status_code=400, detail="templateId required")
    if not isinstance(profile_id, str) or not profile_id:
        raise HTTPException(status_code=400, detail="profileId required")

    templates = _load_templates()
    template = next((t for t in templates if t.get("id") == template_id), None)
    if not template:
        raise HTTPException(status_code=404, detail="template not found")

    profiles = _load_cookies()
    profile = next((p for p in profiles if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail="cookie profile not found")

    payload = template.get("payload")
    if isinstance(payload_override, dict):
        payload = payload_override
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object")

    job_id = _gen_id()
    job = {
        "id": job_id,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
        "status": "queued",
        "jobTimeoutSec": _load_settings().get("jobTimeoutSec", 600),
        "templateId": template_id,
        "templateName": template.get("name"),
        "profileId": profile_id,
        "profileName": profile.get("name"),
        "host": profile.get("host"),
        "taskId": "",
        "taskStatus": "",
        "fileUrl": "",
        "downloadPath": "",
        "extractedFiles": [],
        "error": "",
        "logs": [],
    }

    with _jobs_lock:
        _jobs[job_id] = job

    def log(msg: str) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if not j:
                return
            j["logs"].append(f"[{_now_iso()}] {msg}")
            j["updatedAt"] = _now_iso()

    def update(**kw: Any) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if not j:
                return
            j.update(kw)
            j["updatedAt"] = _now_iso()

    def run() -> None:
        settings = _load_settings()
        job_timeout_sec = float(settings.get("jobTimeoutSec", 600))
        interval_sec = float(settings.get("historyIntervalSec", 3.0))
        req_timeout = float(settings.get("requestTimeoutSec", 25.0))

        started = time.monotonic()
        deadline = started + job_timeout_sec

        def remaining() -> float:
            return max(0.0, deadline - time.monotonic())

        def check_stop() -> None:
            if _shutdown_event.is_set():
                raise rh_client.StopRequested("server shutdown")
            if time.monotonic() >= deadline:
                raise TimeoutError("job timeout")

        update(status="running", jobTimeoutSec=int(job_timeout_sec))
        log(f"job started (timeout={int(job_timeout_sec)}s)")
        try:
            check_stop()
            host = str(profile.get("host") or "www.runninghub.ai")
            record = profile.get("record")
            if not isinstance(record, dict):
                raise RuntimeError("cookie record invalid")

            auth = rh_client.parse_record(host, record)
            token = token_override.strip() or rh_client.extract_access_token(auth)
            if no_auth:
                token = ""

            session = requests.Session()
            rh_client.install_cookies(session, auth)

            check_stop()
            log(f"create: webappId={payload.get('webappId')!r} auth={'yes' if token else 'no'}")
            create_resp = rh_client.create(
                session,
                payload=payload,
                token=token,
                timeout=min(req_timeout, max(3.0, remaining())),
            )

            task_id = rh_client.extract_task_id(create_resp)
            update(taskId=task_id)
            log(f"create ok: taskId={task_id}")

            referer = rh_client.build_referer(payload)
            check_stop()
            hit, last_status = rh_client.wait_for_output(
                session,
                token=token,
                referer=referer,
                task_id=task_id,
                history_pages=3,
                history_size=20,
                interval_sec=interval_sec,
                timeout_sec=remaining(),
                req_timeout=min(req_timeout, max(3.0, remaining())),
                stop_event=_shutdown_event,
            )
            update(taskStatus=last_status)

            if hit is None:
                log(f"history timeout: last_status={last_status!r}")
                update(status="failed", error="history timeout")
                return

            file_url = str(hit.get("fileUrl") or "")
            update(fileUrl=file_url)
            log(f"history: status={last_status!r} fileUrl={'yes' if file_url else 'no'}")

            check_stop()
            if file_url and rh_client.is_task_complete(last_status) and str(last_status).upper() == "SUCCESS":
                out_name = str(hit.get("outputName") or "").strip() or rh_client.default_name_from_url(file_url)
                filename = f"{job_id}-{out_name}"
                path = rh_client.download_file(
                    session,
                    file_url,
                    DOWNLOAD_DIR,
                    filename,
                    timeout=min(req_timeout, max(3.0, remaining())),
                    overwrite=False,
                    stop_event=_shutdown_event,
                    deadline_monotonic=deadline,
                )
                update(downloadPath=f"/downloads/{path.name}")
                log(f"downloaded: {path.name}")

                if path.suffix.lower() == ".zip":
                    try:
                        extract_dir = DOWNLOAD_DIR / f"{job_id}-{path.stem}"
                        files = _safe_extract_zip(path, extract_dir)
                        # Store relative links for the UI.
                        rels: List[str] = []
                        for fp in files:
                            try:
                                rel = fp.resolve().relative_to(DOWNLOAD_DIR.resolve())
                            except Exception:
                                continue
                            rels.append("/downloads/" + "/".join(rel.parts))
                        rels.sort()
                        update(extractedFiles=rels)
                        log(f"unzipped: {len(rels)} files")
                    except Exception as e:
                        log(f"unzip failed: {e}")

            if str(last_status).upper() == "SUCCESS":
                update(status="success")
            else:
                update(status="failed", error=f"taskStatus={last_status}")
        except rh_client.StopRequested as e:
            update(status="cancelled", error=str(e))
            log(f"cancelled: {e}")
        except TimeoutError as e:
            update(status="failed", error=str(e))
            log(f"timeout: {e}")
        except Exception as e:
            update(status="failed", error=str(e))
            log(f"error: {e}")

    def runner() -> None:
        # Limit concurrency, but keep threads daemon so Ctrl+C can exit.
        with _job_slots:
            run()

    threading.Thread(target=runner, daemon=True, name=f"job-{job_id}").start()
    return {"ok": True, "job": job}
