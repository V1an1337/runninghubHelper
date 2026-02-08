#!/usr/bin/env python3
from __future__ import annotations

import os
import sys


def main() -> int:
    # Avoid writing __pycache__ in restricted environments.
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

    # FastAPI file upload (UploadFile/Form) requires python-multipart at import time.
    try:
        import multipart  # type: ignore # noqa: F401
    except Exception:
        print('Missing dependency: python-multipart (import name "multipart")')
        print("Install: pip install -r requirements-webapp.txt")
        return 1

    try:
        import uvicorn  # type: ignore
    except Exception:
        print("Missing dependency: uvicorn")
        print("Install: pip install -r requirements-webapp.txt")
        return 1

    uvicorn.run(
        "webapp.app:app",
        host="127.0.0.1",
        port=8787,
        reload=False,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
