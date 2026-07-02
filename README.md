# Forge Studio

**v4.10.0 — public beta**

An AI-first creative suite built on Forge Neo. Studio gives you a real canvas — layers, brushes, selections, transforms — sitting on top of Forge Neo's generation pipeline, plus built-in modules for **Develop** (post-processing), **Workshop** (model merging), **Gallery**, **Lexicon** (wildcards), and an in-app **Codex** of tutorials.

Studio is a Forge Neo extension. It rides on top of Forge Neo — it doesn't replace it — and inherits the full samplers / LoRAs / VAEs / extensions ecosystem you already have set up. It serves its own UI at `/studio`; Forge Neo's stock Gradio interface remains available alongside it.

> **Public beta.** The core image suite is stable and in daily use, but expect a few rough edges. Bug reports welcome — see [Getting Help](#getting-help).

---

## Requirements

- A working **Forge Neo** install. ([setup guide](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)). Studio does *not* work with classic Forge or AUTOMATIC1111.
- **NVIDIA GPU, 8 GB VRAM recommended** (6 GB works with the Low VRAM launcher and reduced settings).
- Everything Forge Neo already needs — Python 3.10 / 3.11, git, the usual.

### Tested against

Studio targets Forge Neo as of `NEO_COMMIT_HASH` (`NEO_COMMIT_DATE`). Newer Neo commits usually work but are not guaranteed.
<!-- TODO(Tox): replace NEO_COMMIT_HASH / NEO_COMMIT_DATE — run `git -C <neo-checkout> rev-parse HEAD` on the working dev install and record hash + date. -->

### Hardware

Developed on a 16 GB card (RTX 5060 Ti) and a higher-VRAM card; known-working on 6 GB with reduced settings and the Low VRAM launcher.

---

## Installation

1. Clone Studio into your Forge Neo install under `extensions/`:
   ```
   cd sd-webui-forge-neo/extensions/
   git clone https://github.com/ToxicHost/Forge-Studio.git forge-studio
   ```
   (Grabbing a release zip and unzipping it into `extensions/forge-studio/` works too.)
2. **ADetailer (recommended):** Studio's ADetailer integration targets the **Studio fork of ADetailer**, version `26.2.0-studio.1`, installed as a regular extension alongside Studio. Get it from ToxicHost's GitHub. Without it, ADetailer panels are hidden and everything else works normally.
   <!-- TODO(Tox): drop in the exact URL of the ADetailer fork repo/release. -->
3. Launch using one of Studio's `.bat` files (see below). Don't use `webui-user.bat` — Studio's launchers set the flags it needs.
4. First boot installs two small Python packages (`imagehash`, `imageio-ffmpeg`) for Gallery features — let it finish. The first generation after a cold start also triggers Forge's initial model load, which can take noticeably longer than later ones; that's normal.

That's it. Studio opens at **http://127.0.0.1:7860/studio**.

---

## Launching Studio

Studio ships with two Windows launchers. They live in the `forge-studio` folder and call Forge Neo's `webui.bat` with the right flags pre-set.

### `Forge Studio.bat` — standard launcher
The default for any modern NVIDIA card. Enables xformers, SageAttention 2, CUDA malloc, CUDA streams, FP16 fast-path, UV pip, and pinned shared memory. Boots Forge Neo in headless mode (`--nowebui`) and serves Studio on port 7860.

### `Forge_Studio_LowVRAM.bat` — low-VRAM launcher
Same idea, but disables SageAttention and tunes `PYTORCH_CUDA_ALLOC_CONF` for cards with limited VRAM. Use this on 6 GB GPUs or if you hit OOM errors with the standard launcher.

### Tip — desktop shortcut
Right-click either `.bat` file → *Send to* → *Desktop (create shortcut)*. Rename it, give it an icon, pin it to your taskbar. One click to launch.

---

## First Launch

A welcome card asks how you want to start:

- **I'm new to AI image generation** — a guided walkthrough that makes your first image and reveals the UI in stages.
- **I've used Stable Diffusion / Photoshop before** — a quick orientation tour showing what's different about Studio.

You can skip and find your own way. Either path can be restarted from **Settings → Education**.

If you have no models installed, the beginner path detects that and recommends a starter model and where to drop it. Otherwise, place `.safetensors` files in:
```
sd-webui-forge-neo/models/Stable-diffusion/
```
Then click the refresh button (↻) next to the Model dropdown. No restart needed.

---

## Making Your First Image

1. Type a prompt in the prompt box at the top of the Generate panel.
2. Pick a model from the Model dropdown.
3. Press **Ctrl+Enter** (or click Generate).

The image appears on the canvas. From there you can paint on it, mask and inpaint parts of it, drop it into the Gallery, or start over.

For anything else, the **Codex** tab is the in-app manual — searchable, with **Show Me** buttons that walk you through features interactively.

---

## What's Included

### Canvas
A real raster editor on the same surface where images generate:

- **Painting tools** — brush, eraser, eyedropper, fill, gradient, shape (rect/ellipse/line, filled or outline), text, smudge, blur, dodge & burn, clone stamp, liquify (move / pinch / bloat / twirl), pixelate.
- **Selection tools** — rectangular and elliptical marquee, freehand / polygonal / magnetic lasso, magic wand, crop with locked aspect-ratio presets.
- **Transform** — move, scale, rotate, flip, plus **skew**, **perspective**, and **warp** (MLS deformation with 3×3 / 4×4 / 5×5 grid, affine / similitude / rigid).
- **Layers** — full layer stack with blend modes, opacity, masks, adjustment layers, and **PSD export** (with embedded sRGB ICC profile, so Photoshop opens it identically).
- **Symmetry painting** — horizontal, vertical, both axes, or radial (2–16 axes).
- **Pen pressure** — Wacom/tablet support for size and opacity.
- **Brush dynamics** — hardness, smoothing, spacing, opacity, with per-tool memory so each tool remembers its own settings.

### Multi-document tabs
Browser-style tabs along the top of the canvas. **Each tab has its own layers, undo stack, zoom, *and its own prompt and generation settings*.** Switch between projects the way you switch between Chrome tabs. `Ctrl+]` / `Ctrl+[` to cycle.

### Live Painting
A completion-triggered img2img loop. Hit the ▶ Live button and Studio regenerates the canvas every time you stop painting, using your current prompt as guidance. Seed stays locked so iterations stay coherent. *Apply* commits the current preview as a new layer and you keep going.

### Generation features
Everything Forge Neo's pipeline supports, surfaced as inline panels:

- Hires Fix, ADetailer (3 slots), Upscale (with optional refine pass + ADetailer)
- ControlNet (3 slots)
- Regional Prompting + Attention Couple (architecture-aware)
- Soft Inpainting with full parameter control
- Hires checkpoint swap, variation seed, resize-from-seed
- Aspect-ratio buttons with a *randomize* row (random base size, ratio, or orientation per generation)
- LoRA browser, embedding browser, wildcard insertion (with Dynamic Prompts)
- **Civitai metadata lookup** — opt-in. Hash-based, never sends filenames or prompts. Caches previews, trigger words, and model info locally; per-file privacy opt-out from the browser context menu.
- Tag autocomplete — Danbooru, e621, merged Danbooru+e621, Derpibooru
- Prompt scheduling, alternating, composable diffusion, attention weighting — all the standard syntax

### Workflows (generation profiles)
Save the current panel state as a named workflow, then re-apply it to any tab or open a new tab with it preloaded. Pure local presets — no cloud, no sync, no node graphs.

### Develop module
A **Lightroom-style global post-processing pass** that's non-destructive and per-document. White balance, exposure, highlights, shadows, whites/blacks, contrast, vibrance, saturation, clarity & texture (mid-tone weighted USM), sharpening, vignette, grain, plus a color-calibration matrix for highlights/midtones/shadows. Runs after layers, before export.

### Workshop
Full model merger with a serious set of methods:

- Linear (weighted_sum, add_difference, slerp)
- TIES, DARE, DARE-TIES, DELLA, DELLA-TIES, Breadcrumbs
- Cosine-adaptive, Star
- **SVD-based** — struct-A-mag-B, struct-B-mag-A, Procrustes-aligned spectral blend
- Block-weight editor for per-layer alpha
- **LoRA baking** — bakes any adapter (LoRA, LoHa, LoKr, OFT, BOFT, GLoRA, DoRA) directly into a checkpoint
- **VAE baking** — replace a checkpoint's VAE
- Journal & recipes — every merge logged, re-runnable, with diagnostics and a namespace breakdown for tricky architectures

### Gallery
Image library powered by TrackImage (by Moritz). Metadata search, character-tag parsing, bulk operations (move, copy, cut, strip metadata, delete), perceptual-hash duplicate detection, video thumbnails, drag-from-Gallery → canvas, "send-to-canvas" with raw or resolved prompts.

### Lexicon (Wildcards)
A full file-tree editor for Dynamic Prompts wildcard files. Syntax highlighting (comments, nested refs), folders, rename / duplicate, drag-to-move, live preview with resolution, zip import/export.

### Codex
63 in-app documentation entries covering every tool, parameter, and workflow. Searchable. Most have a **Show Me** button that walks you through the feature interactively.

### Quality-of-life
- **Themes** — Studio, Liam, Oliver, ToxicHost, Neutral, Neon
- **Languages** — English, German, French, Spanish (generation-parameter labels stay in English to match tutorial terminology)
- **Accessibility** — colorblind modes (deuteranopia, protanopia, tritanopia), reduced-motion options
- **VRAM** — manual unload button, idle auto-unload (configurable timer), GPU-weights slider
- **High precision** — saves Float32 alongside each image so the Develop module gets full headroom
- **Remember Last Session** — opt-in, per-category (prompts / params / brush / canvas / inpaint / …)
- **Update checker** — built into Settings; tells you when there's a new Studio version

---

## What makes Studio different

### vs. Forge Neo's Gradio UI

Forge Neo's stock interface is the standard Gradio txt2img / img2img tabbed layout. Studio replaces it (without removing it — they coexist) with a canvas-first workflow:

- **Real canvas** with painting, layers, selections, transforms — Gradio has none of this.
- **Live Painting** — paint and watch the generation update; impossible in a form-submit UI.
- **Multi-document tabs** with independent prompts and settings per tab.
- **Image-first inpainting** — paint a mask directly on the canvas, no "send to img2img then upload a mask" round-trip.
- **PSD export with layers preserved.** Hand off to Photoshop or Krita without flattening.
- **Develop module** — Lightroom-style post-processing built in, non-destructive.
- **Built-in modules** — Workshop, Gallery, Lexicon, Codex all live in the same app.
- **Themes, i18n, tag autocomplete, in-app docs** — Gradio's UI has none of these out of the box.
- **Separate URL** at `/studio` — Studio runs alongside the Gradio UI on the same Forge Neo install. Switch back any time.

### vs. Invoke

Invoke is a great canvas-first AI app, but it's its own engine. Studio is built on Forge Neo, which has tradeoffs worth knowing:

- **Forge Neo's full ecosystem.** All your existing samplers, schedulers, LoRAs, embeddings, VAEs, extensions, ControlNet preprocessors, and ADetailer models work in Studio — no separate model libraries, no separate extension store.
- **Wider architecture support.** SD1.5, SDXL, Pony, Illustrious, NoobAI, Flux, Cosmos, Anima — whatever Forge Neo supports, Studio supports.
- **Workshop** — Invoke doesn't merge models. Studio has a full block-weight + SVD-based merger with LoRA/VAE baking.
- **Develop module** — Lightroom-style global post; Invoke's color tools are simpler.
- **Lexicon** — full Dynamic Prompts wildcard file management with live preview.
- **Codex** — interactive in-app tutorials with "Show Me" walkthroughs.
- **Local-first workflows.** Pure local preset files — no required accounts, no cloud sync, no canvas history syncing over a network.

What Invoke does better (so you have the honest picture):

- **Polished node-graph workflows.** Studio's workflows are flat parameter presets, not graphs. If you want a visual node pipeline, ComfyUI/Invoke is still the answer.
- **Web-grade multi-user setup.** Studio runs locally per-user on top of Forge Neo. Invoke has better server-multi-user story.

---

## Roadmap

- **Comic Lab** — a panel-layout / comic-composition module is being explored for a future release.

---

## Getting Help

- **Codex** tab in-app — 63 searchable entries, interactive Show Me tutorials, the first place to look.
- Bug reports, questions, things that don't work — [open an issue](https://github.com/ToxicHost/Forge-Studio/issues) or DM ToxicHost directly.

---

## License

**AGPL-3.0** — see [LICENSE](LICENSE).

---

## Credits

- **Forge Studio** by ToxicHost & Moritz (co-development, testing).
- **Gallery** powered by TrackImage by Moritz.
- **VRAM Unload** and **Civitai metadata lookup** suggested by SnekySnek.
- **Remember Last Session**, **LoRA Stack**, **Resizable Side Panel**, and **UI density polish** suggested by Railer.
- **Closed beta testers** — Frenchy, Jaiguy. Huge thanks for the bug hunts.
- Built on **Forge Neo** by Haoming02, a fork of **Stable Diffusion WebUI Forge** by lllyasviel.
