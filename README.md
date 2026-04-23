# Forge Studio

An AI-first creative suite built on top of Forge Neo. Studio replaces the Gradio interface with a canvas-based workflow, adds painting and layer tools, and bundles Video Lab (WAN video generation), Workshop (model merging), and a Gallery.

Studio is a Forge Neo extension. It doesn't replace Forge Neo — it rides on top of it and reuses its pipeline and extension ecosystem.

> This is a **beta**. Expect rough edges. The Known Limitations section at the bottom covers what's currently in progress.

---

## Requirements

- A working **Forge Neo** install. If you don't have one, follow the [Forge Neo setup](https://github.com/Haoming02/sd-webui-forge-classic/tree/neo) first. Studio will not work with classic Forge or AUTOMATIC1111.
- **NVIDIA GPU, 8 GB VRAM recommended.**
- Everything Forge Neo already needs — Python 3.10 or 3.11, git, the usual.

---

## Installation

1. Unzip the archive you downloaded. You should get a folder named `forge-studio` (or similar).
2. Move that folder into your Forge Neo install under `extensions/`.
   ```
   sd-webui-forge-neo/
     extensions/
       forge-studio/     <-- here
   ```
3. Studio ships with its own launch scripts (`.bat` files) that bypass Forge Neo's default launcher. Use those to start Forge Neo with Studio enabled — don't use `webui-user.bat`.
4. First launch will install a few extra Python packages (`imagehash`, `imageio-ffmpeg`). Wait for it to finish.

That's it. Studio is installed and running.

### Tip: make a desktop shortcut

Right-click the Studio `.bat` file → *Send to* → *Desktop (create shortcut)*. You can rename the shortcut, give it a custom icon, and pin it to your taskbar or Start menu — one click to launch Studio without digging through the Forge Neo folder every time.

---

## First Launch

The first time you open Studio, you'll see a welcome card asking how you want to get started. Pick one:

- **I'm new to AI image generation** — guided walkthrough that makes your first image and reveals the UI in stages.
- **I've used Stable Diffusion, Photoshop, or similar tools** — orientation tour showing what's different about Studio.

You can skip and figure things out yourself if you prefer. Either path can be restarted or changed later from **Settings → Education**.

### If you don't have any models installed

The beginner walkthrough detects this and adds a model-acquisition step with a recommended starter model and folder path. If you're on the experienced path or you skipped, drop a `.safetensors` model into:

```
sd-webui-forge-neo/models/Stable-diffusion/
```

Then click the refresh button (↻) next to the Model dropdown in the Generate panel. No restart needed.

---

## Making Your First Image

1. Type a prompt in the prompt box at the top of the Generate panel.
2. Pick a model from the Model dropdown below the prompts.
3. Press **Ctrl+Enter** (or click Generate).

Your image appears on the canvas. You can paint on it, inpaint parts, send it to Video Lab, or start over.

For everything else, the **Codex** tab is the in-app documentation. 62 entries covering every tool, parameter, and workflow. Most entries have a **Show Me** button that walks you through the feature interactively.

---

## What's Included

- **Canvas** — image generation and painting on the same surface. Layers, selections, transform, brush dynamics, clone stamp, liquify, symmetry tools, and the usual touch-up brushes.
- **Multi-document workspace** — tabs across the top of the canvas let you keep several independent projects open at once. Each tab has its own layers, undo stack, zoom, *and its own prompt and generation settings*. Switch between them like browser tabs. Ctrl+] / Ctrl+[ to cycle.
- **Live Painting** — a completion-triggered img2img loop. Toggle the ▶ Live button and Studio regenerates the canvas every time you stop painting, with your current prompt as guidance. Seed stays locked so iterations stay coherent. Use *Apply* to commit the current preview to a new layer and keep going.
- **Video Lab** — WAN 2.1 / 2.2 video generation with dual-expert model support, TeaCache, NAG, SageAttention 2. Currently WAN-only; other video architectures (Hunyuan, LTX, etc.) are not supported yet.
- **Workshop** — model merging with several SVD-based methods, LoRA baking, VAE baking, and a journal of previous merges.
- **Gallery** — image library with character tag parsing, metadata search, bulk operations, and duplicate detection.
- **Wildcards** — full editor for Dynamic Prompts wildcard files.

---

## Known Limitations

- **Video Lab is in active beta.** Usable and producing results, but still being refined. Expect occasional rough edges and report anything that breaks.
- **Blackwell (RTX 50-series) + FP8 video models may produce corrupted output in Video Lab.** If you hit this, use GGUF-quantized video models instead. Root cause is still under investigation — the same models work fine in other frontends, so it's likely something specific to Studio's generation path.

---

## Getting Help

- In-app **Codex** (the tab in Studio) — 62 entries, searchable, with interactive Show Me tutorials.
- Bug reports, questions, or things that don't work — DM ToxicHost directly.

---

## Credits

- **Forge Studio** by ToxicHost & Moritz.
- **Gallery** powered by TrackImage by Moritz.
- **VRAM Unload** feature suggested by SnekySnek.
- **Remember Last Session** feature suggested by Railer.
- **Closed beta testers** — Frenchy, Jaiguy. Huge thanks for the bug hunts.
- Built on **Forge Neo** by Haoming02, which is a fork of **Stable Diffusion WebUI Forge** by lllyasviel.
