"""Forge Studio — Civitai metadata lookup (opt-in, hash-based)

Looks up LoRA metadata on Civitai by file hash and caches everything
locally so the browser can show previews + trigger words without
re-querying. Privacy guarantees:

  * Default OFF. The frontend never calls these endpoints until the
    user enables the "Civitai metadata lookup" setting.
  * Lookups are by SHA-256 of the file content — filenames are NEVER
    sent to Civitai.
  * Per-file `private: true` marker is honored backend-side: even if a
    fetch request arrives for a private LoRA we refuse and return 403.

Cache layout (one cache dir per LoRA root, sibling to the LoRAs):

  <lora_dir>/.civitai_cache/
      hashes.json                # { rel_path: {mtime, size, hash} }
      <hash>.json                # metadata for one LoRA
      <hash>.preview.<ext>       # downloaded preview image
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

TAG = "[Studio Civitai]"
log = logging.getLogger("studio.civitai")

# Civitai split adult content onto civitai.red. Both hosts expose the same
# /api/v1/model-versions/by-hash endpoint. We try civitai.com first, and fall
# back to civitai.red ONLY on 404 — never on connection errors, so transient
# network problems can't accidentally leak a lookup to the wrong host.
CIVITAI_HOSTS = ("https://civitai.com", "https://civitai.red")
BY_HASH_PATH = "/api/v1/model-versions/by-hash/{hash}"
USER_AGENT = "Forge-Studio (https://github.com/ToxicHost/Forge-Studio)"
REQUEST_TIMEOUT = 30  # seconds — single lookup
HASH_CHUNK_BYTES = 1 << 20  # 1 MiB
CACHE_DIR_NAME = ".civitai_cache"
HASH_INDEX_NAME = "hashes.json"
ALLOWED_PREVIEW_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_PREVIEW_BYTES = 8 * 1024 * 1024  # 8 MiB cap on downloads
LORA_EXTENSIONS = (".safetensors", ".ckpt", ".pt")

def _walk_follow(root):
    """Scanner walk that follows symlinked directories (see studio_walk)."""
    try:
        try:
            from studio_walk import walk_follow
        except ImportError:
            from scripts.studio_walk import walk_follow
    except Exception:
        return os.walk(root)
    return walk_follow(root)



# =========================================================================
# Path / cache helpers
# =========================================================================


def _cache_dir(lora_dir: str) -> Path:
    d = Path(lora_dir) / CACHE_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def _hash_index_path(lora_dir: str) -> Path:
    return _cache_dir(lora_dir) / HASH_INDEX_NAME


def _meta_path(lora_dir: str, sha: str) -> Path:
    return _cache_dir(lora_dir) / f"{sha}.json"


def _preview_path(lora_dir: str, sha: str, ext: str) -> Path:
    if ext not in ALLOWED_PREVIEW_EXTS:
        ext = ".jpg"
    return _cache_dir(lora_dir) / f"{sha}.preview{ext}"


def _existing_preview_in_cache(lora_dir: str, sha: str) -> Optional[Path]:
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        p = _cache_dir(lora_dir) / f"{sha}.preview{ext}"
        if p.is_file():
            return p
    return None


def _read_json(path: Path) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _write_json_atomic(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# =========================================================================
# Hash index — { rel_path: {mtime, size, hash} } per lora root
# =========================================================================


def _load_hash_index(lora_dir: str) -> Dict[str, Dict[str, Any]]:
    data = _read_json(_hash_index_path(lora_dir))
    if not isinstance(data, dict):
        return {}
    return data


def _save_hash_index(lora_dir: str, idx: Dict[str, Dict[str, Any]]) -> None:
    _write_json_atomic(_hash_index_path(lora_dir), idx)


def _compute_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def get_or_compute_hash(lora_dir: str, lora_path: str) -> str:
    """Return SHA-256 of a LoRA file, using the index cache when valid.

    The index entry is keyed by path relative to `lora_dir` and stores
    mtime + size. If either has changed, we re-hash and refresh.
    """
    try:
        st = os.stat(lora_path)
    except OSError:
        raise
    try:
        rel = os.path.relpath(lora_path, lora_dir).replace(os.sep, "/")
    except ValueError:
        # Different drive / not under lora_dir — fall back to absolute key.
        rel = lora_path.replace(os.sep, "/")

    idx = _load_hash_index(lora_dir)
    entry = idx.get(rel)
    if (
        isinstance(entry, dict)
        and entry.get("mtime") == st.st_mtime
        and entry.get("size") == st.st_size
        and isinstance(entry.get("hash"), str)
        and len(entry["hash"]) == 64
    ):
        return entry["hash"]

    sha = _compute_sha256(lora_path)
    idx[rel] = {"mtime": st.st_mtime, "size": st.st_size, "hash": sha}
    try:
        _save_hash_index(lora_dir, idx)
    except OSError as e:
        log.warning("%s Could not write hash index: %s", TAG, e)
    return sha


# =========================================================================
# LoRA path lookup
# =========================================================================


def find_lora_path(
    name: str, lora_dir: str, extra_dirs: Iterable[str]
) -> Optional[Tuple[str, str]]:
    """Find the absolute file path for a LoRA `name` (e.g. "subfolder/lora").

    Returns `(absolute_path, base_dir_that_contains_it)` or `None`.
    Mirrors the search logic in `/studio/loras` and `/studio/lora_preview`.
    """
    name = (name or "").strip().lstrip("/").replace("\\", "/")
    if not name:
        return None
    candidates = [d for d in [lora_dir, *extra_dirs] if d and os.path.isdir(d)]
    rel_os = name.replace("/", os.sep)
    for base in candidates:
        for ext in LORA_EXTENSIONS:
            p = os.path.join(base, rel_os + ext)
            if os.path.isfile(p):
                return p, base
    return None


# =========================================================================
# Civitai API
# =========================================================================


class CivitaiError(Exception):
    pass


class CivitaiNotFound(CivitaiError):
    pass


def _http_get_json(url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise CivitaiNotFound(f"Hash not found on Civitai (HTTP 404)")
        raise CivitaiError(f"HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        raise CivitaiError(f"Network error: {e.reason}")
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise CivitaiError(f"Invalid JSON from Civitai: {e}")


def _http_get_bytes(url: str, byte_cap: int = MAX_PREVIEW_BYTES) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = resp.read(byte_cap + 1)
    except urllib.error.HTTPError as e:
        raise CivitaiError(f"Preview HTTP {e.code}: {e.reason}")
    except urllib.error.URLError as e:
        raise CivitaiError(f"Preview network error: {e.reason}")
    if len(data) > byte_cap:
        raise CivitaiError(f"Preview exceeds {byte_cap // 1024} KB cap")
    return data


def _ext_from_url(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    ext = os.path.splitext(path)[1].lower()
    if ext in ALLOWED_PREVIEW_EXTS:
        return ext
    return ".jpg"


def _shape_metadata(
    sha: str,
    api_resp: dict,
    fetched_at: float,
    *,
    private: bool = False,
    source_host: str = "https://civitai.com",
) -> dict:
    """Normalize Civitai's response into our cache schema. `source_host`
    is the host that actually returned the result (civitai.com or
    civitai.red) — used for the user-facing source URL so "Open on
    Civitai" lands on the right domain."""
    model = api_resp.get("model") or {}
    images = api_resp.get("images") or []
    # Pick first image that's actually an image (not video) and has a URL
    preview_url = None
    for img in images:
        if not isinstance(img, dict):
            continue
        if img.get("type") and img["type"] != "image":
            continue
        if img.get("url"):
            preview_url = img["url"]
            break
    creator = api_resp.get("creator") or {}
    model_id = api_resp.get("modelId")
    version_id = api_resp.get("id")
    source_url = None
    if model_id and version_id:
        source_url = (
            f"{source_host}/models/{model_id}?modelVersionId={version_id}"
        )
    trained_words = api_resp.get("trainedWords") or []
    if not isinstance(trained_words, list):
        trained_words = []

    return {
        "schema": 1,
        "hash": sha,
        "fetched_at": fetched_at,
        "private": bool(private),
        "not_found": False,
        "source_host": source_host,
        "model_id": model_id,
        "version_id": version_id,
        "model_name": model.get("name") or "",
        "version_name": api_resp.get("name") or "",
        "base_model": api_resp.get("baseModel") or "",
        "trigger_words": [str(w) for w in trained_words],
        "author": creator.get("username") or "",
        "source_url": source_url or "",
        "description": api_resp.get("description") or "",
        "preview_url": preview_url or "",
        # Preview-local filename (relative to cache dir) — set after download
        "preview_local": "",
    }


def _shape_not_found(sha: str, fetched_at: float) -> dict:
    return {
        "schema": 1,
        "hash": sha,
        "fetched_at": fetched_at,
        "private": False,
        "not_found": True,
        "source_host": "",
        "model_id": None,
        "version_id": None,
        "model_name": "",
        "version_name": "",
        "base_model": "",
        "trigger_words": [],
        "author": "",
        "source_url": "",
        "description": "",
        "preview_url": "",
        "preview_local": "",
    }


# =========================================================================
# Per-LoRA fetch / cache
# =========================================================================


def load_cached_entry(lora_dir: str, sha: str) -> Optional[dict]:
    return _read_json(_meta_path(lora_dir, sha))


def is_private(lora_dir: str, sha: str) -> bool:
    entry = load_cached_entry(lora_dir, sha) or {}
    return bool(entry.get("private"))


def set_private_flag(lora_dir: str, sha: str, private: bool) -> dict:
    """Toggle the per-file privacy flag. Creates a placeholder cache
    entry if none exists yet so the flag survives even before any
    metadata is fetched."""
    entry = load_cached_entry(lora_dir, sha) or {
        "schema": 1,
        "hash": sha,
        "fetched_at": 0.0,
        "private": False,
        "not_found": False,
        "source_host": "",
        "model_id": None,
        "version_id": None,
        "model_name": "",
        "version_name": "",
        "base_model": "",
        "trigger_words": [],
        "author": "",
        "source_url": "",
        "description": "",
        "preview_url": "",
        "preview_local": "",
    }
    entry["private"] = bool(private)
    _write_json_atomic(_meta_path(lora_dir, sha), entry)
    return entry


def clear_cache(lora_dir: str, sha: str) -> bool:
    """Delete a single LoRA's cached metadata + preview. Returns True if
    anything was removed."""
    removed = False
    meta = _meta_path(lora_dir, sha)
    if meta.is_file():
        try:
            meta.unlink()
            removed = True
        except OSError:
            pass
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        p = _cache_dir(lora_dir) / f"{sha}.preview{ext}"
        if p.is_file():
            try:
                p.unlink()
                removed = True
            except OSError:
                pass
    return removed


def _lookup_by_hash(sha: str) -> Tuple[dict, str]:
    """Try each Civitai host in order. Returns `(api_response, host)` for
    the first one that succeeds. Raises `CivitaiNotFound` only if every
    host returned 404. Any non-404 error (network, 5xx, parse) raises
    immediately — we only fall through on a clean 404.
    """
    last_404 = None
    for host in CIVITAI_HOSTS:
        url = host + BY_HASH_PATH.format(hash=sha)
        try:
            return _http_get_json(url), host
        except CivitaiNotFound as e:
            last_404 = e
            continue
    raise last_404 if last_404 else CivitaiNotFound("All hosts returned 404")


def fetch_one(
    lora_path: str,
    base_dir: str,
    *,
    download_preview: bool = True,
) -> dict:
    """Hash, fetch, and cache one LoRA. Returns the metadata dict.

    Raises CivitaiError on network failure. Returns a `not_found: True`
    entry when no configured host has a record for the hash. Refuses
    (returns the existing entry) when the LoRA is marked private.
    """
    sha = get_or_compute_hash(base_dir, lora_path)
    existing = load_cached_entry(base_dir, sha)
    if existing and existing.get("private"):
        # Don't even hit the network for private LoRAs.
        return existing

    try:
        resp, source_host = _lookup_by_hash(sha)
    except CivitaiNotFound:
        entry = _shape_not_found(sha, time.time())
        if existing and existing.get("private"):
            entry["private"] = True
        _write_json_atomic(_meta_path(base_dir, sha), entry)
        return entry

    entry = _shape_metadata(
        sha, resp, time.time(),
        private=bool(existing and existing.get("private")),
        source_host=source_host,
    )

    if download_preview and entry.get("preview_url"):
        ext = _ext_from_url(entry["preview_url"])
        dest = _preview_path(base_dir, sha, ext)
        try:
            blob = _http_get_bytes(entry["preview_url"])
            dest.write_bytes(blob)
            entry["preview_local"] = dest.name
        except CivitaiError as e:
            log.info("%s Preview download failed for %s: %s", TAG, sha[:10], e)
            # Leave preview_local empty; the entry is still useful.

    _write_json_atomic(_meta_path(base_dir, sha), entry)
    return entry


# =========================================================================
# Enrichment — merges cached Civitai data into /studio/loras response
# =========================================================================


def _public_view(
    entry: dict, cache_dir: Path, file_url_prefix: str = "/file="
) -> dict:
    """Strip internal fields, build the URL for the local preview."""
    preview_url = ""
    local = entry.get("preview_local") or ""
    if local:
        candidate = cache_dir / local
        if candidate.is_file():
            preview_url = file_url_prefix + str(candidate)
    return {
        "fetched_at": entry.get("fetched_at") or 0.0,
        "private": bool(entry.get("private")),
        "not_found": bool(entry.get("not_found")),
        "source_host": entry.get("source_host") or "",
        "model_id": entry.get("model_id"),
        "version_id": entry.get("version_id"),
        "model_name": entry.get("model_name") or "",
        "version_name": entry.get("version_name") or "",
        "base_model": entry.get("base_model") or "",
        "trigger_words": list(entry.get("trigger_words") or []),
        "author": entry.get("author") or "",
        "source_url": entry.get("source_url") or "",
        "description": entry.get("description") or "",
        "preview": preview_url,
    }


def enrich_lora_entries(
    loras: List[dict], lora_dirs_in_order: List[str]
) -> List[dict]:
    """Annotate each entry from `/studio/loras` with cached Civitai
    metadata when available. Never triggers a network call. Falls back
    on the LoRA's existing `preview` / `activation_text` so manual user
    overrides always win.

    `lora_dirs_in_order` should be the same `[lora_dir, *extra_dirs]`
    used by `/studio/loras` so we can find each LoRA's cache root.
    """
    if not loras or not lora_dirs_in_order:
        return loras

    # Pre-load each cache's hash index so we don't re-read for every LoRA.
    indexes: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for d in lora_dirs_in_order:
        if d and os.path.isdir(d):
            try:
                indexes[d] = _load_hash_index(d)
            except Exception:
                indexes[d] = {}

    for entry in loras:
        path = entry.get("path") or ""
        if not path or not os.path.isfile(path):
            continue
        # Locate which base dir holds this file
        base_dir = None
        for d in lora_dirs_in_order:
            if d and path.startswith(d):
                base_dir = d
                break
        if not base_dir:
            continue
        idx = indexes.get(base_dir, {})
        try:
            rel = os.path.relpath(path, base_dir).replace(os.sep, "/")
        except ValueError:
            continue
        cached = idx.get(rel)
        if not isinstance(cached, dict):
            continue
        sha = cached.get("hash")
        if not isinstance(sha, str) or len(sha) != 64:
            continue
        meta = load_cached_entry(base_dir, sha)
        if not meta:
            continue
        view = _public_view(meta, _cache_dir(base_dir))
        entry["civitai"] = view
        # Backfill existing fields when the user has nothing local. Never
        # overwrite the user's own preview file or sidecar activation text.
        if not entry.get("preview") and view.get("preview"):
            entry["preview"] = view["preview"]
        if not entry.get("activation_text") and view.get("trigger_words"):
            entry["activation_text"] = ", ".join(view["trigger_words"])

    return loras


# =========================================================================
# FastAPI routes
# =========================================================================


def setup_civitai_routes(app, get_lora_dirs) -> None:
    """Mount /studio/civitai/* routes on `app`.

    `get_lora_dirs` is a zero-arg callable returning `(lora_dir, extra_dirs)`
    so studio_api.py can share its dir resolution without us re-implementing
    it.
    """
    from fastapi import Body
    from fastapi.responses import JSONResponse

    def _resolve(name: str) -> Optional[Tuple[str, str]]:
        primary, extras = get_lora_dirs()
        if not primary:
            return None
        return find_lora_path(name, primary, extras or [])

    def _refresh_one(name: str) -> dict:
        loc = _resolve(name)
        if not loc:
            return {"ok": False, "name": name, "error": "LoRA file not found"}
        path, base = loc
        try:
            entry = fetch_one(path, base)
            view = _public_view(entry, _cache_dir(base))
            return {
                "ok": True,
                "name": name,
                "private": view["private"],
                "not_found": view["not_found"],
                "civitai": view,
            }
        except CivitaiError as e:
            return {"ok": False, "name": name, "error": str(e)}
        except OSError as e:
            return {"ok": False, "name": name, "error": f"File read error: {e}"}
        except Exception as e:
            log.error("%s Unexpected fetch error for %s: %s\n%s",
                      TAG, name, e, traceback.format_exc())
            return {"ok": False, "name": name, "error": "Unexpected error"}

    @app.post("/studio/civitai/fetch")
    async def civitai_fetch(req: dict = Body(...)):
        name = (req or {}).get("name", "")
        result = _refresh_one(name)
        status = 200 if result.get("ok") else 400
        return JSONResponse(result, status_code=status)

    @app.post("/studio/civitai/fetch_batch")
    async def civitai_fetch_batch(req: dict = Body(...)):
        """Fetch missing metadata for a set of LoRAs.

        Body shape:
          {"names": ["a/b", "c/d"], "skip_existing": true}
          {"folder": "characters", "skip_existing": true}
          {"all": true, "skip_existing": true}

        Always skips LoRAs that already have a cache entry unless
        `skip_existing=false` is explicitly passed. Always honors
        per-file `private`. Returns a summary; per-LoRA detail is kept
        intentionally lean so a 500-LoRA fetch doesn't return an
        enormous payload.
        """
        req = req or {}
        skip_existing = req.get("skip_existing", True)
        primary, extras = get_lora_dirs()
        if not primary:
            return JSONResponse(
                {"ok": False, "error": "No LoRA directory configured"},
                status_code=400,
            )

        # Build name list
        names: List[str] = []
        if isinstance(req.get("names"), list):
            names = [str(n) for n in req["names"] if isinstance(n, str)]
        elif req.get("all") or req.get("folder"):
            # Walk dirs to enumerate
            folder = req.get("folder", "")
            roots = [primary, *(extras or [])]
            for base in roots:
                if not base or not os.path.isdir(base):
                    continue
                for root, dirs, files in _walk_follow(base):
                    for f in files:
                        if not f.endswith(LORA_EXTENSIONS):
                            continue
                        full = os.path.join(root, f)
                        rel = os.path.relpath(full, base).replace(os.sep, "/")
                        name_no_ext = os.path.splitext(rel)[0]
                        if folder and not name_no_ext.startswith(folder.rstrip("/") + "/") \
                                and name_no_ext != folder:
                            # `folder` mode: only entries under that subfolder
                            continue
                        names.append(name_no_ext)
        else:
            return JSONResponse(
                {"ok": False, "error": "Need one of: names, folder, all"},
                status_code=400,
            )

        ok = 0
        skipped = 0
        not_found = 0
        errors: List[Dict[str, str]] = []
        for n in names:
            loc = _resolve(n)
            if not loc:
                errors.append({"name": n, "error": "Not found on disk"})
                continue
            path, base = loc
            if skip_existing:
                try:
                    sha = get_or_compute_hash(base, path)
                except OSError as e:
                    errors.append({"name": n, "error": f"Hash failed: {e}"})
                    continue
                existing = load_cached_entry(base, sha)
                if existing and (existing.get("fetched_at") or existing.get("not_found")):
                    skipped += 1
                    continue
                if existing and existing.get("private"):
                    skipped += 1
                    continue
            try:
                entry = fetch_one(path, base)
                if entry.get("not_found"):
                    not_found += 1
                else:
                    ok += 1
            except CivitaiError as e:
                errors.append({"name": n, "error": str(e)})

        return JSONResponse(
            {
                "ok": True,
                "fetched": ok,
                "not_found": not_found,
                "skipped": skipped,
                "errors": errors[:50],  # cap payload
                "total": len(names),
            }
        )

    @app.post("/studio/civitai/clear_cache")
    async def civitai_clear_cache(req: dict = Body(...)):
        name = (req or {}).get("name", "")
        loc = _resolve(name)
        if not loc:
            return JSONResponse(
                {"ok": False, "error": "LoRA file not found"}, status_code=400
            )
        path, base = loc
        try:
            sha = get_or_compute_hash(base, path)
        except OSError as e:
            return JSONResponse(
                {"ok": False, "error": f"Hash failed: {e}"}, status_code=500
            )
        removed = clear_cache(base, sha)
        return JSONResponse({"ok": True, "removed": removed})

    @app.post("/studio/civitai/private")
    async def civitai_set_private(req: dict = Body(...)):
        req = req or {}
        name = req.get("name", "")
        private = bool(req.get("private", True))
        loc = _resolve(name)
        if not loc:
            return JSONResponse(
                {"ok": False, "error": "LoRA file not found"}, status_code=400
            )
        path, base = loc
        try:
            sha = get_or_compute_hash(base, path)
        except OSError as e:
            return JSONResponse(
                {"ok": False, "error": f"Hash failed: {e}"}, status_code=500
            )
        entry = set_private_flag(base, sha, private)
        return JSONResponse(
            {"ok": True, "private": bool(entry.get("private"))}
        )

    print(f"{TAG} Routes registered")
