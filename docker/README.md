# Forge Studio in Docker

> **Community / unsupported.** The supported install is the normal extension
> drop-in plus the launcher scripts. This exists for people who specifically
> want a container; it is not expected to reach parity with the standard install
> and has not been through the same testing.

## Requirements

- **NVIDIA GPU** on the host, plus the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **Linux**, or **Windows via WSL2**. macOS cannot pass a GPU to a container, so
  it will not work there.
- Disk: the image is roughly **8–12 GB** before any models.

## Run

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Studio is then at **http://localhost:7860/studio**.

The first build clones Forge Classic and installs PyTorch, so expect it to take
a while. Put your checkpoints in `docker/data/models/` (the folders are created
on first run).

## Layout

Three mounts, nothing to pre-create:

| Host | Container | Holds |
|---|---|---|
| `data/models` | `/forge/models` | Checkpoints, LoRAs, VAEs, ADetailer models |
| `data/outputs` | `/forge/outputs` | Generated images |
| `data/studio` | `/studio-data` | Studio defaults, presets, gallery index, wildcard config |

Studio's mutable state is redirected to `/studio-data` by the `STUDIO_DATA_DIR`
environment variable, so **rebuilding the image doesn't lose your settings**.
Without it that state would live inside the extension folder, which is image
content and gets replaced on every rebuild.

If you point `data/studio` at an existing install's state, Studio migrates the
old files across on first use rather than starting empty.

## Configuration

Launch flags come from `COMMANDLINE_ARGS` in `docker-compose.yml` — add `--sage`,
swap in `--medvram`, and so on. Pin the upstream Forge revision once you have a
build that works:

```yaml
build:
  args:
    FORGE_REF: <commit-sha>
```

Leaving it on `main` means a future upstream change can break a rebuild that
previously succeeded.

## Behind a reverse proxy — important

A generation is served by **one long-lived HTTP request** that stays open for the
entire run and returns the images in its response body. nginx's default
`proxy_read_timeout` is **60 seconds**, which will sever any generation longer
than a minute; the browser then reports a network error and the images are
unreachable even though the backend finished and saved them.

Raise the timeouts:

```nginx
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
proxy_buffering    off;   # progress/preview WebSocket
```

Also proxy the WebSocket (`/studio/ws`) with the usual `Upgrade`/`Connection`
headers, or you lose live progress and previews.

## Extensions

Only Studio is installed. To add others (ADetailer, ControlNet, …) either mount a
folder over `/forge/extensions` or extend the Dockerfile with additional clones.
Note that Studio's ADetailer integration supports both the `adetailer` and
`lib_adetailer` package layouts.

## Known limitations

- Not tested in CI; no published image — you build it yourself.
- Models are not included and should not be baked into the image.
- The image is CUDA-only; there is no ROCm or CPU variant.
