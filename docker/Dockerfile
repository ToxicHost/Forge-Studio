# Forge Studio — container image (community / unsupported)
#
# Builds Forge Classic with Forge Studio installed as an extension. Studio is an
# extension, not a standalone app, so the image necessarily contains both.
#
# Requires an NVIDIA GPU on the host plus the NVIDIA Container Toolkit
# (`--gpus all`). Linux, or Windows via WSL2. macOS cannot pass a GPU through.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t forge-studio .

FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# ffmpeg: Gallery video thumbnails. libgl1/libglib2.0: OpenCV runtime deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 python3-venv python3-pip \
        ffmpeg libgl1 libglib2.0-0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the upstream commit. An unpinned clone means a future upstream change can
# silently break a rebuild that previously worked — override at build time with
# --build-arg FORGE_REF=<sha> once you have a known-good revision.
ARG FORGE_REPO=https://github.com/Haoming02/sd-webui-forge-classic
ARG FORGE_REF=main
RUN git clone "${FORGE_REPO}" /forge && \
    cd /forge && git checkout "${FORGE_REF}"

WORKDIR /forge

# Studio itself.
COPY . /forge/extensions/Forge-Studio

# Warm the dependency install at BUILD time instead of first run. Forge installs
# torch et al. from launch.py; without this every fresh container re-downloads
# several GB on first start. Non-fatal: if upstream changes its bootstrap this
# just falls back to installing at runtime.
ENV SKIP_VENV=1
RUN python3 launch.py --skip-torch-cuda-test --exit || \
    echo "[build] dependency warm-up skipped — deps will install on first run"

# All mutable Studio state (defaults, presets, gallery index, wildcards config)
# lives here rather than inside the extension folder, so rebuilding or replacing
# the image never destroys user settings. See scripts/studio_paths.py.
ENV STUDIO_DATA_DIR=/studio-data
RUN mkdir -p /studio-data /forge/models /forge/outputs

VOLUME ["/studio-data", "/forge/models", "/forge/outputs"]
EXPOSE 7860

# --nowebui: Studio serves its own UI; Gradio's is not needed.
# Studio is at http://<host>:7860/studio
ENV COMMANDLINE_ARGS="--xformers --cuda-malloc --cuda-stream --fast-fp16 --nowebui --port 7860 --listen"
CMD ["sh", "-c", "python3 launch.py ${COMMANDLINE_ARGS}"]
