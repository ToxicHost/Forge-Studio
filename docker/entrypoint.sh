#!/bin/bash
# Forge Studio container entrypoint — extends Forge Neo's official one.
set -euo pipefail

ROOT=/home/forge/sd-webui

# TCMalloc reduces memory fragmentation under large model workloads (upstream)
export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libtcmalloc_minimal.so.4

# ── Forge Studio ────────────────────────────────────────────────────────────
# Sync the baked-in Studio into the (possibly bind-mounted) extensions dir.
# A full replace is safe: all mutable Studio state (defaults, presets, gallery
# index, wildcards config, watermarks) lives in STUDIO_DATA_DIR, not here —
# and replacing avoids stale files lingering across image updates.
rm -rf "$ROOT/extensions/Forge-Studio"
cp -a /opt/forge-studio "$ROOT/extensions/Forge-Studio"

# Studio state root (also set in the image; kept here so a docker run without
# compose still gets it). Lives under the persistent config mount.
export STUDIO_DATA_DIR="${STUDIO_DATA_DIR:-$ROOT/config/studio}"
mkdir -p "$STUDIO_DATA_DIR"

# Lexicon wildcards: Studio's fallback root is <webui>/outputs/wildcards, which
# is NOT one of the persistent dirs (Neo's image dir is `output`, singular).
# Point it into the config mount so user wildcard files survive rebuilds.
mkdir -p "$STUDIO_DATA_DIR/wildcards" "$ROOT/outputs"
ln -sfn "$STUDIO_DATA_DIR/wildcards" "$ROOT/outputs/wildcards"

# ── Upstream behavior ───────────────────────────────────────────────────────
# Read COMMANDLINE_ARGS then unset it
RAW_ARGS="${COMMANDLINE_ARGS:-}"
unset COMMANDLINE_ARGS

EXTRA_ARGS=()
if [[ -n "$RAW_ARGS" ]]; then
    read -ra EXTRA_ARGS <<< "$RAW_ARGS"
fi

# Symlink settings files into the config bind-mount so they persist across
# container recreations
for f in config.json ui-config.json styles.csv user.css; do
    ln -sf "$ROOT/config/$f" "$ROOT/$f"
done

# --nowebui: Studio serves its own UI at /studio; Gradio's is not needed.
# --port 7860 is REQUIRED here: in --nowebui mode Forge defaults to 7861,
# which would break the port mapping and healthcheck.
exec python "$ROOT/launch.py" \
    --listen \
    --nowebui \
    --port 7860 \
    "${EXTRA_ARGS[@]}" \
    "$@"
