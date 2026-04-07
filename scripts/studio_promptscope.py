"""
Forge Studio — PromptScope Integration
by ToxicHost & Moritz

Bridges PromptScope's analysis pipeline into Studio's API.
Two endpoints:
  /studio/promptscope/tokens  — fast token count for live display
  /studio/promptscope/analyze — full analysis with structured JSON output
"""

import os
import sys
import json
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse

TAG = "[PromptScope]"

# ── Locate PromptScope extension ──

_ps_lib = None
_ps_available = False
_tag_db = None


def _find_promptscope():
    """Find and import PromptScope's lib directory."""
    global _ps_lib, _ps_available, _tag_db

    try:
        from modules.paths import script_path
    except ImportError:
        script_path = os.path.abspath(".")

    candidates = [
        os.path.join(script_path, "extensions", "PromptScope", "lib"),
        os.path.join(script_path, "extensions", "promptscope", "lib"),
        os.path.join(script_path, "extensions", "PromptScope", "PromptScope", "lib"),
    ]

    lib_dir = None
    data_dir = None
    for c in candidates:
        if os.path.isdir(c):
            lib_dir = c
            data_dir = os.path.join(os.path.dirname(c), "data")
            break

    if not lib_dir:
        print(f"{TAG} PromptScope extension not found — skipping")
        return

    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)

    try:
        from tag_database import TagDatabase
        from prompt_parser import parse_prompt, tags_to_string_list
        from tokenizer_analysis import analyze_tokenization, estimate_tokenization_offline
        from collision_detection import detect_collisions, detect_collisions_offline
        from conflict_rules import check_conflicts
        from prompt_coach import analyze_and_coach
        from prompt_scoring import score_prompt
        from model_detection import detect_model_family, check_model_tips
        from prompt_fixer import fix_prompt

        # Load tag database
        db_path = os.path.join(data_dir, "illustrious_tags.json") if data_dir else None
        tag_db = TagDatabase()
        if db_path and os.path.exists(db_path):
            tag_db.load(db_path)
            print(f"{TAG} Tag database loaded ({tag_db.meta.get('total_tags', 0)} tags)")
        else:
            print(f"{TAG} Tag database not found at {db_path}")

        _tag_db = tag_db
        _ps_available = True
        _ps_lib = {
            "parse_prompt": parse_prompt,
            "tags_to_string_list": tags_to_string_list,
            "analyze_tokenization": analyze_tokenization,
            "estimate_tokenization_offline": estimate_tokenization_offline,
            "detect_collisions": detect_collisions,
            "detect_collisions_offline": detect_collisions_offline,
            "check_conflicts": check_conflicts,
            "analyze_and_coach": analyze_and_coach,
            "score_prompt": score_prompt,
            "detect_model_family": detect_model_family,
            "check_model_tips": check_model_tips,
            "fix_prompt": fix_prompt,
        }
        print(f"{TAG} PromptScope integration loaded from {lib_dir}")

    except Exception as e:
        print(f"{TAG} Failed to import PromptScope lib: {e}")
        import traceback
        traceback.print_exc()


def _get_tokenizers():
    """Get CLIP tokenizers from the loaded model."""
    try:
        from modules import shared
        sd = shared.sd_model
        if sd is None or type(sd).__name__ == "FakeInitialModel":
            return None, None

        clip_l = None
        clip_g = None

        engine_l = getattr(sd, "text_processing_engine_l", None)
        engine_g = getattr(sd, "text_processing_engine_g", None)

        if engine_l:
            clip_l = getattr(engine_l, "tokenizer", None)
        if engine_g:
            clip_g = getattr(engine_g, "tokenizer", None)

        # Fallback: forge_objects.clip.tokenizer
        if not clip_l or not clip_g:
            fo = getattr(sd, "forge_objects", None)
            if fo:
                clip_obj = getattr(fo, "clip", None)
                if clip_obj:
                    tok = getattr(clip_obj, "tokenizer", None)
                    if tok:
                        if not clip_l:
                            clip_l = getattr(tok, "clip_l", None)
                        if not clip_g:
                            clip_g = getattr(tok, "clip_g", None)

        if clip_l and not callable(clip_l):
            clip_l = None
        if clip_g and not callable(clip_g):
            clip_g = None

        return clip_l, clip_g

    except Exception:
        return None, None


def setup_promptscope_routes(app: FastAPI):
    """Register PromptScope API routes."""

    _find_promptscope()

    if not _ps_available:
        print(f"{TAG} Routes not registered — PromptScope not available")
        return

    @app.post("/studio/promptscope/tokens")
    async def promptscope_tokens(req: dict):
        """Fast token count for live display."""
        prompt = req.get("prompt", "")
        if not prompt.strip():
            return {"tokens_l": 0, "tokens_g": 0, "chunks": 1, "offline": True}

        lib = _ps_lib
        parsed = lib["parse_prompt"](prompt)
        clean_tags = lib["tags_to_string_list"](parsed)
        if not clean_tags:
            return {"tokens_l": 0, "tokens_g": 0, "chunks": len(parsed.chunks), "offline": True}

        clip_l, clip_g = _get_tokenizers()
        offline = clip_l is None

        if not offline:
            tok_results = lib["analyze_tokenization"](clean_tags, clip_l, clip_g)
        else:
            tok_results = lib["estimate_tokenization_offline"](clean_tags)

        total_l = sum(r.clip_l_token_count for r in tok_results)
        total_g = sum(r.clip_g_token_count for r in tok_results)

        return {
            "tokens_l": total_l,
            "tokens_g": total_g,
            "chunks": len(parsed.chunks),
            "offline": offline,
        }

    @app.post("/studio/promptscope/analyze")
    async def promptscope_analyze(req: dict):
        """Full prompt analysis — returns structured JSON."""
        prompt = req.get("prompt", "")
        model_selection = req.get("model_family", "auto")
        experience_level = req.get("experience_level", "intermediate")

        if not prompt.strip():
            return {"error": "Empty prompt"}

        lib = _ps_lib
        tag_db = _tag_db

        # Parse
        parsed = lib["parse_prompt"](prompt)
        clean_tags = lib["tags_to_string_list"](parsed)
        if not clean_tags:
            return {"error": "No tags found"}

        # Database analysis
        tag_analyses = tag_db.batch_analyze(clean_tags) if tag_db and tag_db.is_loaded else [
            {"input": t, "known": False, "status": "unknown", "tier": "unknown",
             "posts": 0, "category": None, "suggestions": []}
            for t in clean_tags
        ]

        # Tokenization
        clip_l, clip_g = _get_tokenizers()
        model_loaded = clip_l is not None

        if model_loaded:
            tok_results = lib["analyze_tokenization"](clean_tags, clip_l, clip_g)
        else:
            tok_results = lib["estimate_tokenization_offline"](clean_tags)

        # Model detection
        model_info = lib["detect_model_family"](manual_selection=model_selection)

        # Conflicts
        conflict_report = lib["check_conflicts"](
            clean_tags, tag_analyses=tag_analyses, parsed_prompt=parsed,
        )

        # Coaching
        coach_report = lib["analyze_and_coach"](
            clean_tags, parsed_prompt=parsed, tag_analyses=tag_analyses,
        )

        # Model tips
        model_tips = lib["check_model_tips"](
            clean_tags, model_info=model_info, experience_level=experience_level,
        )

        # Score
        score_result = lib["score_prompt"](
            clean_tags,
            tag_analyses=tag_analyses,
            conflict_count=len(conflict_report.conflicts),
            heads_up_count=conflict_report.heads_up_count,
            tip_count=len(coach_report.tips),
            parsed_prompt=parsed,
            experience_level=experience_level,
        )

        # Fix suggestions (don't apply — return as suggestions)
        fix_result = lib["fix_prompt"](
            prompt,
            tag_analyses=tag_analyses,
            model_tips=model_tips,
            model_family=model_info.family,
        )

        # Build structured response
        return {
            "score": {
                "overall": score_result.overall,
                "grade": score_result.grade,
                "label": score_result.label,
                "dimensions": [
                    {"name": d.name, "score": d.score, "detail": d.detail, "icon": d.icon}
                    for d in score_result.dimensions
                ],
                "suggestions": score_result.suggestions,
            },
            "tokens": {
                "total_l": sum(r.clip_l_token_count for r in tok_results),
                "total_g": sum(r.clip_g_token_count for r in tok_results),
                "chunks": len(parsed.chunks),
                "offline": not model_loaded,
            },
            "tags": [
                {
                    "tag": ta["input"],
                    "known": ta.get("known", False),
                    "posts": ta.get("posts", 0),
                    "category": ta.get("category"),
                    "tier": ta.get("tier", "unknown"),
                    "is_alias": ta.get("is_alias", False),
                    "canonical": ta.get("canonical"),
                    "suggestions": ta.get("suggestions", [])[:3],
                    "tokens_l": tok_results[i].clip_l_token_count if i < len(tok_results) else 0,
                    "tokens_g": tok_results[i].clip_g_token_count if i < len(tok_results) else 0,
                }
                for i, ta in enumerate(tag_analyses)
            ],
            "conflicts": [
                {
                    "severity": c.severity,
                    "category": c.category,
                    "title": c.title,
                    "detail": c.detail,
                    "tags": c.tags_involved,
                }
                for c in conflict_report.conflicts
            ],
            "tips": [
                {"text": t} if isinstance(t, str) else
                {"text": getattr(t, "text", str(t)), "category": getattr(t, "category", "")}
                for t in (coach_report.tips if hasattr(coach_report, "tips") else [])
            ],
            "model_tips": [
                {"text": t} if isinstance(t, str) else
                {"text": getattr(t, "text", str(t)), "severity": getattr(t, "severity", "")}
                for t in (model_tips if model_tips else [])
            ],
            "fixes": [
                {
                    "action": f.action,
                    "description": f.description,
                    "original": f.original,
                    "replacement": f.replacement,
                }
                for f in fix_result.fixes
            ] if not fix_result.unchanged else [],
            "model": {
                "family": model_info.family if hasattr(model_info, "family") else "unknown",
                "loaded": model_loaded,
            },
        }
