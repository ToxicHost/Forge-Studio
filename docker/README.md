# Forge Studio in Docker

> **Community / unsupported.** The supported install is the normal extension
> drop-in plus the launcher scripts. This container exists for people who
> specifically want one; it tracks [Forge Neo's own official Docker
> image](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo/docker)
> and adds Studio on top.

## Requirements

- **NVIDIA GPU**, driver **560+** (upstream's requirement), plus the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **Linux**, or **Windows via WSL2**. macOS cannot pass a GPU to a container.
- Disk: several GB for the image, plus your models.

## Run

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml logs -f   # watch first-run install
```

Studio is then at **http://localhost:7860/studio**.

The build pre-installs PyTorch; the **first start** installs the remaining
requirements and extension dependencies (a few minutes, needs network). Later
starts skip all of that. Put checkpoints in `docker/data/models/Stable-diffusion/`.

A one-shot `init-perms` service fixes bind-mount ownership for the container's
non-root user (UID 99 / GID 100, same as upstream), so no manual `chown` is
needed on Linux.

## Layout

| Host (under `docker/`) | Container | Holds |
|---|---|---|
| `data/models` | `…/models` | Checkpoints, LoRAs, VAEs, ControlNet, ADetailer models |
| `data/output` | `…/output` | Generated images (Neo's dir name, singular) |
| `data/extensions` | `…/extensions` | Your extensions — Studio is baked in and re-synced here on every start |
| `data/config` | `…/config` | Forge settings + **all Studio state** (`config/studio/`: defaults, presets, gallery index, wildcards, watermarks) |

`STUDIO_DATA_DIR` points Studio's mutable state at `config/studio`, so
**rebuilding the image never loses settings**, and replacing the Studio code on
each start is safe. Wildcard files are also redirected there (Studio's fallback
`outputs/wildcards` path is not otherwise persistent).

## Configuration

Extra launch flags go in `COMMANDLINE_ARGS` in the compose file. The entrypoint
always passes `--listen --nowebui --port 7860` — the explicit port matters, as
Forge's API-only mode otherwise defaults to **7861**. The Windows launcher's
performance flags are opt-in:

```yaml
COMMANDLINE_ARGS: "--xformers --cuda-malloc --cuda-stream --pin-shared-memory --fast-fp16"
```

(`--xformers`/`--sage` trigger a wheel install on next start; if no wheel
matches the Python 3.13 + current-torch combo the attention backend falls back,
so treat them as optional tuning, not requirements.)

The upstream Forge revision is **pinned** in the Dockerfile (`FORGE_REF`) to a
commit verified against this Studio release. Move it deliberately:

```yaml
build:
  args:
    FORGE_REF: <commit-sha>
```

## Adding extensions (ADetailer, ControlNet, …)

Drop them into `docker/data/extensions/` and restart. Note Forge only runs
extension installers when its own requirements check fails (in practice: on the
first ever start). If a newly added extension needs Python packages, install
them into the venv once:

```bash
docker compose -f docker/docker-compose.yml exec forge-studio \
  pip install <package>
```

Studio's ADetailer integration supports both the `adetailer` and
`lib_adetailer` package layouts.

## Behind a reverse proxy — important

A generation is served by **one long-lived HTTP request** that stays open for
the whole run and returns the images in its response body. nginx's default
`proxy_read_timeout` is **60 seconds** — it will sever any generation longer
than a minute; the browser then reports a network error even though the backend
finished and saved the images.

```nginx
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
proxy_buffering    off;
```

Also proxy the WebSocket (`/studio/ws`) with the usual `Upgrade`/`Connection`
headers, or live progress and previews stop working.

## Known limitations

- Built locally, not published; not covered by CI.
- CUDA-only (no ROCm/CPU variant), matching upstream's image.
- The unrelated prebuilt `oromis995/sd-forge-neo` image mentioned by upstream
  does **not** include Studio.
