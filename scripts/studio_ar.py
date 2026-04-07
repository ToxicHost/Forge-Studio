"""
Forge Studio — AR Randomizer
Native aspect ratio randomization for txt2img generation.

Replaces Moritz's AR Selector extension with a clean, Studio-native implementation.
Randomizes base size, aspect ratio, and/or orientation per-image in the batch loop.

Key improvements over the extension:
- No Gradio component capture hacks
- No metadata patching (dimensions are set before process_images builds info text)
- No inpainting sniff test (Studio already knows is_txt2img)
- Dimensions always rounded to 8 (VAE alignment)
- Pool filtering via frontend UI

by ToxicHost & Moritz (original concept)
"""

import random
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

TAG = "[Studio AR]"

# Canonical sets — must match frontend
ALL_BASES = [512, 640, 768, 896, 1024]
ALL_RATIOS = [
    (1, 1, "1:1"),
    (5, 4, "5:4"),
    (4, 3, "4:3"),
    (3, 2, "3:2"),
    (16, 9, "16:9"),
    (2, 1, "2:1"),
    (239, 100, "2.39:1"),
]

# Lookup: string label → (a, b) numerator/denominator
_RATIO_MAP = {label: (a, b) for a, b, label in ALL_RATIOS}


@dataclass
class ARConfig:
    """AR randomization configuration from the frontend."""
    rand_base: bool = False
    rand_ratio: bool = False
    rand_orientation: bool = False
    base_pool: List[int] = field(default_factory=list)
    ratio_pool: List[str] = field(default_factory=list)

    @property
    def any_active(self) -> bool:
        return self.rand_base or self.rand_ratio or self.rand_orientation


def _parse_ratio(label: str) -> Optional[Tuple[int, int]]:
    """Parse a ratio label like '4:3' or '2.39:1' into (a, b) integers."""
    if label in _RATIO_MAP:
        return _RATIO_MAP[label]
    try:
        parts = label.split(":")
        a, b = float(parts[0]), float(parts[1])
        # Convert to integer form (multiply to clear decimals)
        if a != int(a) or b != int(b):
            a, b = round(a * 100), round(b * 100)
        return (int(a), int(b))
    except (ValueError, IndexError):
        return None


def _resolve_base_pool(pool: List[int]) -> List[int]:
    """Resolve base pool — empty means all."""
    if pool:
        valid = [b for b in pool if b in ALL_BASES]
        return valid if valid else ALL_BASES
    return ALL_BASES


def _resolve_ratio_pool(pool: List[str]) -> List[Tuple[int, int, str]]:
    """Resolve ratio pool — empty means all. Returns list of (a, b, label) tuples."""
    if pool:
        result = []
        for label in pool:
            parsed = _parse_ratio(label)
            if parsed:
                result.append((parsed[0], parsed[1], label))
        return result if result else ALL_RATIOS
    return ALL_RATIOS


def _round8(n: int) -> int:
    """Round to nearest multiple of 8."""
    return max(8, round(n / 8) * 8)


def randomize_dimensions(
    width: int, height: int, config: ARConfig
) -> Tuple[int, int, Optional[str]]:
    """
    Randomize generation dimensions based on config.

    Args:
        width: Current generation width
        height: Current generation height
        config: AR randomization configuration

    Returns:
        (new_width, new_height, info_string_or_None)
    """
    if not config.any_active:
        return width, height, None

    # --- Derive current state from dimensions ---
    cur_short = min(width, height)
    cur_long = max(width, height)
    cur_is_portrait = height > width
    cur_ratio_val = cur_long / cur_short if cur_short > 0 else 1.0

    # --- Base ---
    if config.rand_base:
        pool = _resolve_base_pool(config.base_pool)
        base = random.choice(pool)
    else:
        # Snap to nearest canonical base
        base = min(ALL_BASES, key=lambda b: abs(b - cur_short))

    # --- Ratio ---
    ratio_label = None
    if config.rand_ratio:
        pool = _resolve_ratio_pool(config.ratio_pool)
        a, b, ratio_label = random.choice(pool)
        ratio_val = max(a, b) / min(a, b)
    else:
        ratio_val = cur_ratio_val

    # --- Orientation ---
    if config.rand_orientation:
        # 1:1 doesn't have orientation
        is_portrait = random.choice([True, False]) if ratio_val > 1.001 else False
    else:
        is_portrait = cur_is_portrait

    # --- Compute final dimensions ---
    short_side = _round8(base)
    long_side = _round8(round(base * ratio_val))

    if ratio_val <= 1.001:
        # Square
        w, h = short_side, short_side
    elif is_portrait:
        w, h = short_side, long_side
    else:
        w, h = long_side, short_side

    orient_str = "portrait" if is_portrait else "landscape"
    info = f"{w}×{h} (base={base}, ratio={ratio_label or f'{ratio_val:.2f}'}, {orient_str})"
    print(f"{TAG} Randomized: {info}")

    return w, h, info
