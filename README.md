# Forge Studio

An AI-first creative suite built on Forge Neo. Studio gives you a real canvas — layers, brushes, selections, transforms — sitting on top of Forge Neo's generation pipeline, plus built-in modules for **Develop** (post-processing), **Video Lab** (WAN video), **Workshop** (model merging), **Gallery**, **Wildcards**, and an in-app **Codex** of tutorials.

Studio is a Forge Neo extension. It rides on top of Forge Neo — it doesn't replace it — and inherits the full samplers / LoRAs / VAEs / extensions ecosystem you already have set up.

> **Beta.** Expect a few rough edges. The Known Limitations section at the bottom covers what's still in progress.

---

## Requirements

- A working **Forge Neo** install. ([setup guide](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo)). Studio does *not* work with classic Forge or AUTOMATIC1111.
- **NVIDIA GPU, 8 GB VRAM recommended** (6 GB works with the Low VRAM launcher).
- Everything Forge Neo already needs — Python 3.10 / 3.11, git, the usual.

---

## Installation

1. Unzip the archive — you'll get a folder named `forge-studio` (or similar).
2. Drop it into your Forge Neo install under `extensions/`:
   ```
   sd-webui-forge-neo/
     extensions/
       forge-studio/     ← here
   ```
3. Launch using one of Studio's `.bat` files (see below). Don't use `webui-user.bat` — Studio's launchers set the flags it needs.
4. First launch installs two small Python packages (`imagehash`, `imageio-ffmpeg`) for Gallery features. Let it finish.

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

The image appears on the canvas. From there you can paint on it, mask and inpaint parts of it, send it to Video Lab, drop it into the Gallery, or start over.

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

### Video Lab
**WAN 2.1 / 2.2** video generation with dual-expert model support, **TeaCache** (CVPR 2025), **NAG** (Normalized Attention Guidance for proper negative prompts), **CFGZeroStar**, **Sigma Shift**, and **SageAttention 2**. Canvas content becomes the I2V reference frame automatically — paint a starting image, hit generate, get video. *Currently WAN-only; Hunyuan/LTX support not yet implemented.*

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

### Wildcards
A full file-tree editor for Dynamic Prompts wildcard files. Syntax highlighting (comments, nested refs), folders, rename / duplicate, drag-to-move, live preview with resolution, zip import/export.

### Codex
67 in-app documentation entries covering every tool, parameter, and workflow. Searchable. Most have a **Show Me** button that walks you through the feature interactively.

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
- **Built-in modules** — Workshop, Video Lab, Gallery, Wildcards, Codex all live in the same app.
- **Themes, i18n, tag autocomplete, in-app docs** — Gradio's UI has none of these out of the box.
- **Separate URL** at `/studio` — Studio runs alongside the Gradio UI on the same Forge Neo install. Switch back any time.

### vs. Invoke

Invoke is a great canvas-first AI app, but it's its own engine. Studio is built on Forge Neo, which has tradeoffs worth knowing:

- **Forge Neo's full ecosystem.** All your existing samplers, schedulers, LoRAs, embeddings, VAEs, extensions, ControlNet preprocessors, and ADetailer models work in Studio — no separate model libraries, no separate extension store.
- **Wider architecture support.** SD1.5, SDXL, Pony, Illustrious, NoobAI, Flux, Cosmos, Anima, WAN — whatever Forge Neo supports, Studio supports.
- **Workshop** — Invoke doesn't merge models. Studio has a full block-weight + SVD-based merger with LoRA/VAE baking.
- **Video Lab** — WAN video generation runs in the same app; no separate ComfyUI workflow.
- **Develop module** — Lightroom-style global post; Invoke's color tools are simpler.
- **Wildcards editor** — full Dynamic Prompts file management with live preview.
- **Codex** — interactive in-app tutorials with "Show Me" walkthroughs.
- **Local-first workflows.** Pure local preset files — no required accounts, no cloud sync, no canvas history syncing over a network.

What Invoke does better (so you have the honest picture):

- **Polished node-graph workflows.** Studio's workflows are flat parameter presets, not graphs. If you want a visual node pipeline, ComfyUI/Invoke is still the answer.
- **Web-grade multi-user setup.** Studio runs locally per-user on top of Forge Neo. Invoke has better server-multi-user story.

---

## Known Limitations

- **Video Lab is in active beta.** Working and producing results, but still being refined. Report anything that breaks.
- **Blackwell (RTX 50-series) + FP8 video models may produce corrupted output in Video Lab.** Use GGUF-quantized video models as a workaround. Root cause is under investigation — the same models work in other frontends, so it's something specific to Studio's generation path.

---

## Getting Help

- **Codex** tab in-app — 67 searchable entries, interactive Show Me tutorials, the first place to look.
- Bug reports, questions, things that don't work — DM ToxicHost directly.

---

## Credits

- **Forge Studio** by ToxicHost & Moritz.
- **Gallery** powered by TrackImage by Moritz.
- **VRAM Unload** feature suggested by SnekySnek.
- **Remember Last Session**, **LoRA Stack**, **Resizable Side Panel**, and **UI density polish** suggested by Railer.
- **Closed beta testers** — Frenchy, Jaiguy. Huge thanks for the bug hunts.
- Built on **Forge Neo** by Haoming02, a fork of **Stable Diffusion WebUI Forge** by lllyasviel.
