"""Delivery proof photo storage. Local disk by default (served under /api/uploads).

Swap `save_photo` for an S3 / GCS upload in production; callers only use the returned URL.
"""
import base64
import binascii
import re

from fastapi import HTTPException, UploadFile

from .. import config
from ..utils import new_id

ALLOWED = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_BYTES = 6 * 1024 * 1024


async def save_photo(file: UploadFile, prefix: str) -> str:
    return _store(await file.read(), file.content_type or "", prefix)


def save_data_url(data_url: str, prefix: str) -> str:
    """Photo sent as a data URL (the app shrinks camera photos to a small JPEG before upload)."""
    m = re.match(r"^data:(image/[a-z]+);base64,(.+)$", data_url, re.S)
    if not m:
        raise HTTPException(400, "Take a photo of the delivered milk first")
    try:
        data = base64.b64decode(m.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "That photo couldn't be read. Please retake it.")
    return _store(data, m.group(1), prefix)


def _store(data: bytes, content_type: str, prefix: str) -> str:
    ext = ALLOWED.get(content_type)
    if not ext:
        raise HTTPException(400, "Photo must be a JPG, PNG or WEBP image")
    if len(data) > MAX_BYTES:
        raise HTTPException(400, "Photo is too large (max 6 MB)")
    if not data:
        raise HTTPException(400, "Photo is empty")
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{prefix}_{new_id()[:10]}.{ext}"
    (config.UPLOAD_DIR / name).write_bytes(data)
    return f"{config.PUBLIC_BASE_URL}/api/uploads/{name}"
