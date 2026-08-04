# Forge Studio — container image (community / unsupported)
#
# Based on Forge Neo's own official docker/Dockerfile (Haoming02/
# sd-webui-forge-classic, branch `neo`), with Forge Studio baked in. Deviating
# from upstream's proven recipe is how container builds rot, so this mirrors it:
# same base, same uv-managed Python 3.13 venv, same torch pre-install, same
# non-root UID 99 / GID 100 (nobody:users, Unraid-friendly).
#
# Requires an NVIDIA GPU (driver 560+, per upstream) and the NVIDIA Container
# Toolkit. Linux, or Windows via WSL2. macOS cannot pass a GPU through.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t forge-studio .

ARG CUDA_VERSION=12.6.3

FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu22.04

# See: https://download.pytorch.org/whl/
ARG TORCH_INDEX=cu126

# Pinned Forge Neo revision (branch `neo`), verified against this Studio
# release. Override with --build-arg FORGE_REF=<sha> to move it — an unpinned
# branch means a future upstream change can break a rebuild that worked.
ARG FORGE_REF=fd64ddb9effa6b88fcb5123bcfba31926c61e3ff

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=automatic \
    UV_NO_CACHE=1 \
    TORCH_INDEX_URL=https://download.pytorch.org/whl/${TORCH_INDEX}

# uv binary (installs Python 3.13 itself)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# ffmpeg: Studio Gallery video thumbnails. libgl1/libglib2.0: OpenCV runtime.
# libtcmalloc: upstream preloads it to cut memory fragmentation.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        ffmpeg \
        git \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libtcmalloc-minimal4 \
    && rm -rf /var/lib/apt/lists/*

# Non-Root User (UID 99 / GID 100 = nobody:users), as upstream
RUN groupadd -g 100 users 2>/dev/null || true \
    && useradd -u 99 -g 100 -d /home/forge -m -s /bin/bash forge

WORKDIR /home/forge/sd-webui

# Fetch Forge Neo at the PINNED revision (shallow fetch of the exact sha —
# GitHub serves reachable-sha fetches, so no full clone is needed).
RUN git init -q . \
    && git remote add origin https://github.com/Haoming02/sd-webui-forge-classic.git \
    && git fetch --depth 1 origin "${FORGE_REF}" \
    && git checkout -q FETCH_HEAD \
    && chown -R 99:100 /home/forge

# Forge Studio, staged OUTSIDE the extensions dir. The entrypoint syncs it into
# extensions/Forge-Studio at startup, so users can bind-mount extensions/ for
# their own additions (ADetailer, ControlNet, ...) without the mount shadowing
# the baked-in Studio. Safe to re-sync on every start because Studio's mutable
# state lives in STUDIO_DATA_DIR, not the extension folder.
COPY --chown=99:100 . /opt/forge-studio

USER forge

# Python 3.13 virtual environment (upstream's choice for the neo branch)
RUN uv venv venv --python 3.13 --seed

ENV VIRTUAL_ENV="/home/forge/sd-webui/venv" \
    PATH="/home/forge/sd-webui/venv/bin:$PATH" \
    PYTHON="/home/forge/sd-webui/venv/bin/python3.13"

# PyTorch pre-install at build time (requirements.txt leaves torch unpinned, so
# this satisfies it and first start doesn't download ~2.5 GB). The remaining
# requirements and extension deps install on first run via prepare_environment,
# exactly as upstream's image does.
RUN uv pip install torch torchvision \
    --index-url "https://download.pytorch.org/whl/${TORCH_INDEX}"

# Persistent data directories (upstream's set; `output` is Neo's dir name).
# config/studio is where STUDIO_DATA_DIR points — Studio defaults, presets,
# gallery index, wildcards, watermarks all persist under the config mount.
RUN mkdir -p \
        models/Stable-diffusion \
        models/VAE \
        models/Lora \
        models/ControlNet \
        extensions \
        config/studio \
        output

ENV STUDIO_DATA_DIR=/home/forge/sd-webui/config/studio

COPY --chown=99:100 docker/entrypoint.sh /home/forge/sd-webui/entrypoint.sh
RUN chmod +x /home/forge/sd-webui/entrypoint.sh

EXPOSE 7860

# NOTE: in --nowebui mode Forge defaults to port 7861; the entrypoint passes
# --port 7860 explicitly, and this healthcheck hits Studio's own route (`/`
# does not exist in API-only mode). Long start-period: first run installs the
# remaining requirements.
HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=15 \
    CMD curl -f http://localhost:7860/studio || exit 1

ENTRYPOINT ["/home/forge/sd-webui/entrypoint.sh"]
