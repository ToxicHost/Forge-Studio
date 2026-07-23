# Performance validation protocol — within-session pairs only

This is a **process rule**, not a suggestion. Cross-session throughput
comparisons burned the preview-performance investigation twice: the machine
drifted ~10–15% between relaunches (closed-tab hires went 1.65 → 1.90 s/it on
identical settings), which produced one false "the fix is inert" verdict.

## Rules

1. **A performance claim requires an A/B within one server session.** Settings
   identical, fixed seed, and only the controlled variable changed between the
   two runs. Do not relaunch between the A and B runs.
2. **Numbers from different sessions may be reported but never compared.**
   Machine state (thermals, VRAM fragmentation, background load) drifts across
   relaunches by more than the effect sizes we chase.
3. **Hires `s/it` is the primary metric** — it is stable within a condition.
   Base `it/s` is noisy (±10% within a single session) and must never gate a
   decision on its own.
4. **Every perf log submitted must include the `[Studio Preview]` diagnostic
   line**, so the active preview path (mode / stream / filter / dims / interval)
   is part of the record. A number without that line is unanchored.
5. **Also capture the `[Studio Perf]` telemetry lines** (see below). They print
   the environment once and one summary per generation, so a submitted log
   self-identifies the hardware, launch flags, and where time actually went.

## `[Studio Perf]` telemetry

Emitted to the Python console (grep `[Studio Perf]`):

- **`env:`** — logged once on the first generation: GPU, VRAM, torch/CUDA
  versions, active launch flags (attention backend, medvram/lowvram), whether
  Neo exposes `vae_stream`, and the Studio preview-stream priority. This line
  anchors every number that follows to a concrete machine + configuration.
- **`model reload: N.NNs (method)`** — printed only when a generation triggered
  a checkpoint reload, so a slow first run is distinguishable from a slow swap.
- **`gen:`** — one per generation, with **non-additive** accounting:
  - `run_generation` — the whole generation call (model load + all sampling
    passes + ADetailer + final VAE). It reads several seconds over the
    sampler-only tqdm rate **by design** — it is not sampling-only.
  - `save` — encode + disk + sidecars; `setup` — preflight before generation;
    `total_wall` — measured independently with `perf_counter` from handler entry.
  - `preview_work_sum` — cumulative preview decode/encode time. It **overlaps**
    `run_generation` (side stream during sampling) and is labeled
    *non-additive* — never add it to `run_generation`.
  - A `WARNING: timer accounting drift` line prints if the separately-measured
    phases (`setup + run_generation + save`) fail to reconcile with `total_wall`.

All preview/timing metrics use `time.perf_counter()`. Forge's own "Time taken"
is now reset immediately before `process_images()` (not during Studio preflight),
so it excludes model-load time.

When comparing an A/B pair, read `run_generation` from the `gen:` line together
with hires `s/it`; do not treat `run_generation` as sampling time.

## Preview demand-gating (Preview-off case)

The preview decode is now gated on client demand: the backend skips the TAESD
decode entirely when no connected client has the Live Preview toggle on **and**
a visible tab (Live Painting always forces previews on). The frontend declares
its state over the progress WebSocket (`preview_config`) on connect, on toggle,
on tab visibility change, and at generation start.

**Preview-off A/B** (same session, fixed seed, `1024×1280 → 2048×2560`,
20 + 20 steps):

- **Run A:** Live Preview toggle **off** (or tab hidden the whole run).
- **Run B:** Live Preview toggle **on**, tab foregrounded.

**Pass:** with the toggle off, the console shows **no** `Preview path:` decode
activity and `[Studio Perf] gen:` reports `previews=0`; hires `s/it` for Run A
is at or below Run B. This is the case gating is meant to fix — cosmetic decodes
must not run when nobody is watching.

## Preview quality modes (Preview-on case)

The **default is `Auto`**: a **full-resolution TAESD decode** (the latent is NOT
resized — its statistics match what the decoder expects, so it can't garble),
followed by a **GPU resize of the decoded RGB** (bicubic + antialias) to display
size *before* the CPU transfer. This keeps the old decoder semantics while
transferring only the small display-size tensor. The `[Studio Preview]` line
reads `mode=auto path=post-decode-gpu filter=bicubic-aa`.

Two other modes (Settings → Live preview quality):

- **`Fast` (experimental)** — resizes the latent *before* TAESD
  (`path=reduced-latent`). Cheaper at hires but format-sensitive; gated to
  validated latent channel counts (4 / 16) and **auto-falls back to Auto** on
  anything else. Some model families produce garbled previews here — it is opt-in.
- **`Legacy`** — exact former path: full-res decode + CPU (PIL/Lanczos)
  downscale (`path=post-decode-cpu`). Diagnostic / A-B only.

The Studio preview side-stream is normal priority (`priority=0`, never `-1`);
Studio does not borrow Neo's `vae_stream`.

**Garble diagnosis:** capture the same seed/step in all three modes. `Legacy`
clean + `Auto` clean + `Fast` garbled → the reduced-latent path is incompatible
for that model/format. `Legacy` and `Auto` both garbled → snapshot race or wrong
latent format. Only hires garbled → hires phase-transition / stale cache.

Validate with the **Standard preview A/B** below; the pass criterion (open-tab
within ~2% of closed-tab) is unchanged, and the status line should read
`mode=auto stream=studio`.

## Standard preview A/B

Same session, fixed seed, `1024×1280 → 2048×2560`, 20 + 20 steps, ADetailer
off, AR randomization off:

- **Run A:** tab open and in the foreground, previews visibly updating.
- **Run B:** tab closed (control).

**Pass:** open-tab hires `s/it` is within ~2% of closed-tab `s/it`, and the
preview updates ~9 times across the generation (one per fresh decode, not once
per polling tick). Report **both** numbers; do not compare against any earlier
session.

## WP2 native batching

`STUDIO_NATIVE_BATCHING` defaults **off**. Enable it (`STUDIO_NATIVE_BATCHING=1`)
only for a validation session, then run the 8-item matrix (seed reproduction,
wildcard determinism, per-image AD, throughput, HP batch, fallback, interrupt,
bridge audit) plus a fast-path hires run that produces **zero** script-runner
tracebacks in the console.
