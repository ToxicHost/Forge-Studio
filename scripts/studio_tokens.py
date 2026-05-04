"""
Studio Token Counter — standalone token + BREAK chunk counter.

No external extension dependencies. Walks Forge's loaded model to find
CLIP-L/G tokenizers, splits the prompt on BREAK boundaries, and returns
total token counts per encoder plus the chunk count.

Falls back to a model-independent CLIP-L tokenizer (loaded from the
HuggingFace cache or fetched once) when no Forge model is loaded yet,
so the counter shows real numbers from the moment Studio opens.

Endpoint:  POST /studio/tokens
Request:   {"prompt": str}
Response:  {
    "tokens_l": int | None,   # None if neither model nor offline tokenizer available
    "tokens_g": int | None,
    "chunks":   int,          # always >= 1
    "offline":  bool,         # true when counts came from the offline fallback
}
"""

import re
from typing import Callable, Optional, Tuple

from fastapi import FastAPI

TAG = "[Studio][Tokens]"
_BREAK_RE = re.compile(r"\bBREAK\b", re.IGNORECASE)

# Offline tokenizer state (loaded lazily, retained for the process lifetime).
# CLIP-L's BPE vocab is universal across SD 1.5 / SDXL / Flux — one tokenizer
# covers ~all checkpoints. SDXL also has CLIP-G with a slightly different
# tokenizer, but the token counts come out within ~1 token of CLIP-L for
# almost any prompt, so we use the L tokenizer for both encoders offline.
_offline_tokenizer = None
_offline_load_failed = False


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
# Offline fallback — CLIP-L tokenizer from HuggingFace cache
# --------------------------------------------------------------------------

def _get_offline_tokenizer() -> Optional[Callable]:
    """Return a CLIP-L tokenizer loaded independently of Forge's model state.

    Uses ``transformers.CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")``,
    which reads from HuggingFace's local cache or fetches once on first call.
    Result is memoized for the process lifetime; if loading fails (no network
    on first run, transformers missing, etc.) the failure is also memoized so
    we don't retry on every keystroke.
    """
    global _offline_tokenizer, _offline_load_failed
    if _offline_tokenizer is not None:
        return _offline_tokenizer
    if _offline_load_failed:
        return None
    try:
        from transformers import CLIPTokenizer
        _offline_tokenizer = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
        print(f"{TAG} Offline CLIP-L tokenizer loaded — counter works without checkpoint")
        return _offline_tokenizer
    except Exception as e:
        _offline_load_failed = True
        print(f"{TAG} Offline tokenizer unavailable ({type(e).__name__}: {e}) — counter shows chunks only when no model loaded")
        return None


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
            return {"tokens_l": 0, "tokens_g": 0, "chunks": 1, "offline": False}

        # Split on BREAK — each chunk is its own 75-token attention window
        raw_chunks = _BREAK_RE.split(prompt)
        chunk_texts = [c.strip() for c in raw_chunks if c.strip()]
        chunk_count = max(1, len(chunk_texts))

        clip_l, clip_g = _get_tokenizers()
        offline = False

        # No model loaded: try the offline CLIP-L tokenizer
        if clip_l is None and clip_g is None:
            fallback = _get_offline_tokenizer()
            if fallback is not None:
                clip_l = fallback   # stand in for both encoders
                offline = True
            else:
                return {"tokens_l": None, "tokens_g": None, "chunks": chunk_count, "offline": False}

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
            "offline":  offline,
        }

    print(f"{TAG} Token counter routes registered (/studio/tokens)")
