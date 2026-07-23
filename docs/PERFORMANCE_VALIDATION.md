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
4. **Every perf log submitted must include the `[Studio API] Preview path:`
   status line**, so the active preview configuration (stream / interval /
   downscale) is part of the record. A number without that line is unanchored.
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
- **`gen:`** — one per generation: `compute` (the sampler/VAE work), `save`
  (encode + disk + sidecars), `total`, plus preview cost for that run
  (`previews=` fresh-decode count, `decode_total`/`avg` ms), the `stream` and
  `downscale` path taken, and the `task` id.

When comparing an A/B pair, read `compute` from the `gen:` line — it excludes
save/postprocess noise and is the cleanest per-run number after hires `s/it`.

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

## Latent-first decode + stream priority (Preview-on case)

Two changes target the default Preview-on path:

- The latent is downscaled **before** the TAESD decode (`downscale=latent-first`
  in the status line), so the decoder itself processes far fewer pixels at hires
  rather than decoding full-res and shrinking afterward.
- The Studio preview side-stream is created at **normal priority** (`priority=0`,
  not the old `-1`, which in PyTorch is *higher* priority and let cosmetic
  decodes preempt the sampler). Studio no longer borrows Neo's `vae_stream`.

Validate with the **Standard preview A/B** below; the pass criterion (open-tab
within ~2% of closed-tab) is unchanged, but the status line should now read
`stream=studio` and `downscale=latent-first`.

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
