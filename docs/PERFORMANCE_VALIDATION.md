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
