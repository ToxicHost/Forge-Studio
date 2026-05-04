"""
Studio Token Counter — standalone token + BREAK chunk counter.

No external extension dependencies. Walks Forge's loaded model to find
CLIP-L/G tokenizers, splits the prompt on BREAK boundaries, and returns
total token counts per encoder plus the chunk count.

Endpoint:  POST /studio/tokens
Request:   {"prompt": str}
Response:  {
    "tokens_l": int | None,   # None if no model loaded
    "tokens_g": int | None,
    "chunks":   int,          # always >= 1
}
"""

import re
from typing import Callable, Optional, Tuple

from fastapi import FastAPI

TAG = "[Studio][Tokens]"
_BREAK_RE = re.compile(r"\bBREAK\b", re.IGNORECASE)


# --------------------------------------------------------------------------
# Tokenizer lookup — fallback chain across Forge model variants
# --------------------------------------------------------------------------

def _get_tokenizers() -> Tuple[Optional[Callable], Optional[Callable]]:
    """Locate CLIP-L and CLIP-G tokenizers from the currently loaded Forge model.

    Tries two paths in order:
      1. ``shared.sd_model.text_processing_engine_l/g.tokenizer`` (standard SDXL)
      2. ``shared.sd_model.forge_objects.clip.tokenizer.clip_l/g`` (fallback)

    Returns ``(None, None)`` if no model is loaded or the model is the
    placeholder ``FakeInitialModel``.
    """
    try:
        from modules import shared
        sd = shared.sd_model
        if sd is None or type(sd).__name__ == "FakeInitialModel":
            return None, None

        clip_l = None
        clip_g = None

        # Primary: text_processing_engine_l/g
        engine_l = getattr(sd, "text_processing_engine_l", None)
        engine_g = getattr(sd, "text_processing_engine_g", None)
        if engine_l:
            clip_l = getattr(engine_l, "tokenizer", None)
        if engine_g:
            clip_g = getattr(engine_g, "tokenizer", None)

        # Fallback: forge_objects.clip.tokenizer.clip_l/g
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

        # Sanity: tokenizers must be callable
        if clip_l and not callable(clip_l):
            clip_l = None
        if clip_g and not callable(clip_g):
            clip_g = None

        return clip_l, clip_g

    except Exception as e:
        print(f"{TAG} Tokenizer lookup failed: {e}")
        return None, None


# --------------------------------------------------------------------------
# Tokenization
# --------------------------------------------------------------------------

def _count_tokens(tokenizer: Callable, text: str) -> int:
    """Tokenize ``text`` and return the count of meaningful tokens.

    Strips BOS/EOS markers (CLIP uses 49406/49407) and any residual padding.
    Truncation is disabled so users see the true count even when over 75 —
    this is a counter, not a generator.
    """
    try:
        encoded = tokenizer(
            text,
            padding=False,
            truncation=False,
            add_special_tokens=True,
            return_tensors=None,
        )
        ids = encoded["input_ids"]
        # Strip BOS (start) and EOS (end)
        if len(ids) >= 2:
            ids = ids[1:-1]
        # Filter residual padding/EOS
        ids = [t for t in ids if t not in (0, 49407)]
        return len(ids)
    except Exception as e:
        print(f"{TAG} Tokenization error: {e}")
        return 0


# --------------------------------------------------------------------------
# Route registration
# --------------------------------------------------------------------------

def setup_token_routes(app: FastAPI) -> None:
    """Register Studio's standalone token-counter route."""

    @app.post("/studio/tokens")
    async def studio_tokens(req: dict):
        prompt = (req.get("prompt") or "").strip()
        if not prompt:
            return {"tokens_l": 0, "tokens_g": 0, "chunks": 1}

        # Split on BREAK — each chunk is its own 75-token attention window
        raw_chunks = _BREAK_RE.split(prompt)
        chunk_texts = [c.strip() for c in raw_chunks if c.strip()]
        chunk_count = max(1, len(chunk_texts))

        clip_l, clip_g = _get_tokenizers()

        # No model loaded: return chunk count only, signal unknown token totals
        if clip_l is None and clip_g is None:
            return {"tokens_l": None, "tokens_g": None, "chunks": chunk_count}

        total_l = 0
        total_g = 0
        for text in chunk_texts:
            if clip_l:
                total_l += _count_tokens(clip_l, text)
            if clip_g:
                total_g += _count_tokens(clip_g, text)

        return {
            "tokens_l": total_l if clip_l else None,
            "tokens_g": total_g if clip_g else None,
            "chunks":   chunk_count,
        }

    print(f"{TAG} Token counter routes registered (/studio/tokens)")
