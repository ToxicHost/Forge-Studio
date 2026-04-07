"""
Forge Studio — Lexicon Module (Backend)
by ToxicHost & Moritz

Wildcard file manager for Dynamic Prompts.
Phase 1: file tree, open/edit/save, create, delete
Phase 2: folder create, rename, duplicate
Phase 3: live preview — resolve wildcards via Dynamic Prompts
Phase 4: move files between folders, zip export/import

All file operations scoped to the wildcards root.
No path traversal, no symlink following, write ops only touch .txt files.
"""

import io
import json
import os
import re
import shutil
import time
import zipfile
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

TAG = "[Lexicon]"
VERSION = "1.0.0"

_wildcards_root: str = ""


def _find_wildcards_dir() -> str:
    """Auto-detect the Dynamic Prompts wildcards directory."""
    from modules.paths import script_path
    candidates = [
        os.path.join(script_path, "extensions", "sd-dynamic-prompts", "wildcards"),
        os.path.join(script_path, "extensions-builtin", "sd-dynamic-prompts", "wildcards"),
        os.path.join(script_path, "extensions", "sd-dynamic-prompts-fork", "wildcards"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return os.path.realpath(c)
    fallback = os.path.join(script_path, "outputs", "wildcards")
    os.makedirs(fallback, exist_ok=True)
    print(f"{TAG} Dynamic Prompts wildcards dir not found — using fallback: {fallback}")
    return os.path.realpath(fallback)


def _get_root() -> str:
    global _wildcards_root
    if not _wildcards_root:
        _wildcards_root = _find_wildcards_dir()
    return _wildcards_root


def _safe_path(rel_path: str) -> str:
    """Resolve a relative path and verify it's inside the wildcards root."""
    root = _get_root()
    cleaned = rel_path.replace("\\", "/")
    if ".." in cleaned.split("/"):
        raise ValueError("Path traversal rejected")
    full = os.path.realpath(os.path.join(root, cleaned))
    if not full.startswith(root):
        raise ValueError("Path outside wildcards directory")
    return full


def _rel_path(abs_path: str) -> str:
    return os.path.relpath(abs_path, _get_root()).replace("\\", "/")


def _sanitize_name(name: str) -> str:
    name = name.strip()
    name = re.sub(r'[^\w\-. ]', '_', name)
    if not name:
        raise ValueError("Empty filename")
    return name


def _build_tree(dir_path: str, rel_prefix: str = "") -> dict:
    name = os.path.basename(dir_path) or "wildcards"
    node = {"name": name, "path": rel_prefix, "type": "folder", "children": []}
    try:
        entries = sorted(os.listdir(dir_path), key=lambda x: (not os.path.isdir(os.path.join(dir_path, x)), x.lower()))
    except PermissionError:
        return node

    for entry in entries:
        if entry.startswith("."):
            continue
        full = os.path.join(dir_path, entry)
        child_rel = os.path.join(rel_prefix, entry).replace("\\", "/") if rel_prefix else entry

        if os.path.isdir(full):
            node["children"].append(_build_tree(full, child_rel))
        elif entry.endswith(".txt"):
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    line_count = sum(1 for _ in f)
            except Exception:
                line_count = 0
            node["children"].append({"name": entry, "path": child_rel, "type": "file", "lines": line_count})
    return node


# =========================================================================
# WILDCARD RESOLUTION
# =========================================================================

_resolver_cache = {}

def _get_resolver():
    if "gen" in _resolver_cache:
        return _resolver_cache["gen"]
    try:
        from dynamicprompts.generators import RandomPromptGenerator
        from dynamicprompts.wildcards.wildcard_manager import WildcardManager
        wc_dir = _get_root()
        if os.path.isdir(wc_dir):
            wm = WildcardManager(Path(wc_dir))
            gen = RandomPromptGenerator(wildcard_manager=wm)
        else:
            gen = RandomPromptGenerator()
        _resolver_cache["gen"] = gen
        return gen
    except ImportError:
        print(f"{TAG} dynamicprompts library not available — resolve will return raw text")
        return None
    except Exception as e:
        print(f"{TAG} Resolver init error: {e}")
        return None


def _resolve_text(text: str) -> str:
    if not text or ("__" not in text and "{" not in text):
        return text
    gen = _get_resolver()
    if not gen:
        return text
    try:
        results = gen.generate(text, num_images=1)
        if results and results[0]:
            return results[0]
    except Exception as e:
        print(f"{TAG} Resolve error: {e}")
    return text


# =========================================================================
# ROUTE REGISTRATION
# =========================================================================

def setup_lexicon_routes(app: FastAPI):
    """Register Lexicon API routes."""

    # ------------------------------------------------------------------
    # Tree
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/tree")
    async def lexicon_tree():
        root = _get_root()
        if not os.path.isdir(root):
            return JSONResponse({"error": "Wildcards directory not found"}, status_code=404)
        return _build_tree(root)

    # ------------------------------------------------------------------
    # File read
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/file")
    async def lexicon_file(path: str):
        try:
            full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not os.path.isfile(full):
            return JSONResponse({"error": "File not found"}, status_code=404)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception as e:
            return JSONResponse({"error": f"Read error: {e}"}, status_code=500)
        lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
        stat = os.stat(full)
        return {"path": path, "content": content, "lines": lines, "modified": stat.st_mtime, "size": stat.st_size}

    # ------------------------------------------------------------------
    # File save
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/file/save")
    async def lexicon_file_save(req: dict):
        path = req.get("path", "")
        content = req.get("content", "")
        if not path:
            return JSONResponse({"error": "No path"}, status_code=400)
        try:
            full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not full.endswith(".txt"):
            return JSONResponse({"error": "Only .txt files"}, status_code=400)
        lines = content.split("\n")
        cleaned = "\n".join(line.rstrip() for line in lines)
        if cleaned and not cleaned.endswith("\n"):
            cleaned += "\n"
        try:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write(cleaned)
        except Exception as e:
            return JSONResponse({"error": f"Write error: {e}"}, status_code=500)
        line_count = cleaned.count("\n")
        return {"ok": True, "lines": line_count, "size": len(cleaned.encode("utf-8"))}

    # ------------------------------------------------------------------
    # File create
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/file/create")
    async def lexicon_file_create(req: dict):
        parent = req.get("path", "")
        name = req.get("name", "")
        try:
            name = _sanitize_name(name)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not name.endswith(".txt"):
            name += ".txt"
        rel = os.path.join(parent, name).replace("\\", "/") if parent else name
        try:
            full = _safe_path(rel)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if os.path.exists(full):
            return JSONResponse({"error": "File already exists"}, status_code=409)
        try:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write("")
        except Exception as e:
            return JSONResponse({"error": f"Create error: {e}"}, status_code=500)
        return {"ok": True, "path": rel}

    # ------------------------------------------------------------------
    # Folder create
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/folder/create")
    async def lexicon_folder_create(req: dict):
        parent = req.get("path", "")
        name = req.get("name", "")
        try:
            name = _sanitize_name(name)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        rel = os.path.join(parent, name).replace("\\", "/") if parent else name
        try:
            full = _safe_path(rel)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if os.path.exists(full):
            return JSONResponse({"error": "Folder already exists"}, status_code=409)
        try:
            os.makedirs(full)
        except Exception as e:
            return JSONResponse({"error": f"Create error: {e}"}, status_code=500)
        return {"ok": True, "path": rel}

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    @app.delete("/studio/lexicon/file")
    async def lexicon_file_delete(path: str):
        try:
            full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not os.path.exists(full):
            return JSONResponse({"error": "Not found"}, status_code=404)
        if os.path.isdir(full):
            if os.listdir(full):
                return JSONResponse({"error": "Folder is not empty"}, status_code=400)
            try:
                os.rmdir(full)
            except Exception as e:
                return JSONResponse({"error": f"Delete error: {e}"}, status_code=500)
        else:
            if not full.endswith(".txt"):
                return JSONResponse({"error": "Only .txt files can be deleted"}, status_code=400)
            try:
                os.remove(full)
            except Exception as e:
                return JSONResponse({"error": f"Delete error: {e}"}, status_code=500)
        return {"ok": True}

    # ------------------------------------------------------------------
    # Rename
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/file/rename")
    async def lexicon_file_rename(req: dict):
        path = req.get("path", "")
        new_name = req.get("new_name", "")
        if not path or not new_name:
            return JSONResponse({"error": "Path and new_name required"}, status_code=400)
        try:
            new_name = _sanitize_name(new_name)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        try:
            full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not os.path.exists(full):
            return JSONResponse({"error": "Not found"}, status_code=404)
        is_file = os.path.isfile(full)
        if is_file and not new_name.endswith(".txt"):
            new_name += ".txt"
        parent_dir = os.path.dirname(full)
        new_full = os.path.join(parent_dir, new_name)
        new_full_real = os.path.realpath(new_full)
        if not new_full_real.startswith(_get_root()):
            return JSONResponse({"error": "Path outside wildcards directory"}, status_code=400)
        if os.path.exists(new_full) and os.path.realpath(full) != new_full_real:
            return JSONResponse({"error": "Name already taken"}, status_code=409)
        try:
            os.rename(full, new_full)
        except Exception as e:
            return JSONResponse({"error": f"Rename error: {e}"}, status_code=500)
        return {"ok": True, "new_path": _rel_path(new_full)}

    # ------------------------------------------------------------------
    # Duplicate
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/file/duplicate")
    async def lexicon_file_duplicate(req: dict):
        path = req.get("path", "")
        if not path:
            return JSONResponse({"error": "No path"}, status_code=400)
        try:
            full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if not os.path.isfile(full):
            return JSONResponse({"error": "File not found"}, status_code=404)
        if not full.endswith(".txt"):
            return JSONResponse({"error": "Only .txt files"}, status_code=400)
        parent_dir = os.path.dirname(full)
        stem = os.path.basename(full)[:-4]
        copy_name = stem + "_copy.txt"
        copy_full = os.path.join(parent_dir, copy_name)
        counter = 2
        while os.path.exists(copy_full):
            copy_name = f"{stem}_copy{counter}.txt"
            copy_full = os.path.join(parent_dir, copy_name)
            counter += 1
        try:
            shutil.copy2(full, copy_full)
        except Exception as e:
            return JSONResponse({"error": f"Duplicate error: {e}"}, status_code=500)
        return {"ok": True, "path": _rel_path(copy_full)}

    # ------------------------------------------------------------------
    # Move file/folder to a new parent directory
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/file/move")
    async def lexicon_file_move(req: dict):
        path = req.get("path", "")
        dest_folder = req.get("dest", "")  # relative path of destination folder ("" = root)

        if not path:
            return JSONResponse({"error": "No path"}, status_code=400)

        try:
            src_full = _safe_path(path)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)

        if not os.path.exists(src_full):
            return JSONResponse({"error": "Source not found"}, status_code=404)

        # Resolve destination
        root = _get_root()
        if dest_folder:
            try:
                dest_full = _safe_path(dest_folder)
            except ValueError as e:
                return JSONResponse({"error": str(e)}, status_code=400)
        else:
            dest_full = root

        if not os.path.isdir(dest_full):
            return JSONResponse({"error": "Destination is not a folder"}, status_code=400)

        name = os.path.basename(src_full)
        new_full = os.path.join(dest_full, name)
        new_full_real = os.path.realpath(new_full)

        if not new_full_real.startswith(root):
            return JSONResponse({"error": "Destination outside wildcards directory"}, status_code=400)

        # Don't move into itself (for folders)
        if os.path.isdir(src_full) and new_full_real.startswith(os.path.realpath(src_full)):
            return JSONResponse({"error": "Cannot move a folder into itself"}, status_code=400)

        if os.path.exists(new_full):
            return JSONResponse({"error": f'"{name}" already exists in destination'}, status_code=409)

        # Don't move to same location
        if os.path.dirname(os.path.realpath(src_full)) == os.path.realpath(dest_full):
            return {"ok": True, "new_path": path}  # no-op

        try:
            shutil.move(src_full, new_full)
        except Exception as e:
            return JSONResponse({"error": f"Move error: {e}"}, status_code=500)

        return {"ok": True, "new_path": _rel_path(new_full)}

    # ------------------------------------------------------------------
    # Search filenames
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/search")
    async def lexicon_search(q: str = ""):
        if not q or len(q) < 2:
            return []
        root = _get_root()
        q_lower = q.lower()
        results = []
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                if not fn.endswith(".txt"):
                    continue
                if q_lower in fn.lower():
                    full = os.path.join(dirpath, fn)
                    rel = os.path.relpath(full, root).replace("\\", "/")
                    results.append({"name": fn, "path": rel})
                    if len(results) >= 50:
                        return results
        return results

    # ------------------------------------------------------------------
    # Resolve wildcards
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/resolve")
    async def lexicon_resolve(text: str = ""):
        if not text:
            return {"result": ""}
        return {"result": _resolve_text(text)}

    # ------------------------------------------------------------------
    # Search file contents
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/search_content")
    async def lexicon_search_content(q: str = ""):
        if not q or len(q) < 2:
            return []
        root = _get_root()
        q_lower = q.lower()
        results = []
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                if not fn.endswith(".txt"):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace("\\", "/")
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        for i, line in enumerate(f, 1):
                            if q_lower in line.lower():
                                results.append({
                                    "name": fn,
                                    "path": rel,
                                    "line": i,
                                    "text": line.strip()[:120],
                                })
                                if len(results) >= 100:
                                    return results
                                break  # one match per file is enough
                except Exception:
                    pass
        return results

    # ------------------------------------------------------------------
    # Export — zip the entire wildcards tree
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/export")
    async def lexicon_export():
        root = _get_root()
        if not os.path.isdir(root):
            return JSONResponse({"error": "Wildcards directory not found"}, status_code=404)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, dirnames, filenames in os.walk(root):
                # Skip hidden dirs
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for fn in filenames:
                    if not fn.endswith(".txt"):
                        continue
                    full = os.path.join(dirpath, fn)
                    arcname = os.path.relpath(full, root).replace("\\", "/")
                    zf.write(full, arcname)

        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=wildcards_export.zip"},
        )

    # ------------------------------------------------------------------
    # Import — upload a zip, extract .txt files into wildcards
    # ------------------------------------------------------------------

    @app.post("/studio/lexicon/import")
    async def lexicon_import(request: Request):
        root = _get_root()
        body = await request.body()

        if len(body) == 0:
            return JSONResponse({"error": "Empty upload"}, status_code=400)

        if len(body) > 100 * 1024 * 1024:  # 100 MB limit
            return JSONResponse({"error": "File too large (100 MB max)"}, status_code=400)

        try:
            buf = io.BytesIO(body)
            zf = zipfile.ZipFile(buf, "r")
        except zipfile.BadZipFile:
            return JSONResponse({"error": "Invalid zip file"}, status_code=400)

        imported = 0
        skipped = 0

        for info in zf.infolist():
            if info.is_dir():
                continue
            # Only import .txt files
            name = info.filename.replace("\\", "/")
            if not name.endswith(".txt"):
                skipped += 1
                continue
            # Security: reject paths with ..
            if ".." in name.split("/"):
                skipped += 1
                continue

            dest = os.path.realpath(os.path.join(root, name))
            if not dest.startswith(root):
                skipped += 1
                continue

            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(zf.read(info.filename))
                imported += 1
            except Exception as e:
                print(f"{TAG} Import skip {name}: {e}")
                skipped += 1

        zf.close()
        return {"ok": True, "imported": imported, "skipped": skipped}

    # ------------------------------------------------------------------
    # Info
    # ------------------------------------------------------------------

    @app.get("/studio/lexicon/info")
    async def lexicon_info():
        root = _get_root()
        file_count = 0
        if os.path.isdir(root):
            for _, _, files in os.walk(root):
                file_count += sum(1 for f in files if f.endswith(".txt"))
        return {"root": root, "exists": os.path.isdir(root), "file_count": file_count}

    print(f"{TAG} Routes registered (v{VERSION})")
