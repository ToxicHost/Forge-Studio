# Forge Studio

**Version 1.0** — by ToxicHost & Moritz

A standalone drawing and generation tab for [Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge), featuring a full-featured canvas with built-in ADetailer and Hires Fix equivalents — no separate extensions required.

---

## Features

- **Multi-layer canvas** with Sketch, Reference, and Inpaint layers
- **Rich brush engine** — round, flat, scatter, and marker presets with hardness, opacity, pressure sensitivity, stroke smoothing, and symmetry mirroring
- **Three generation modes**: Create (txt2img-style sketching), Edit (inpainting), and img2img
- **Inpaint Sketch sub-mode** — draw directly over the image to define inpaint regions
- **Built-in Hires Fix** — upscale and refine in one pass using any installed upscaler
- **Multi-slot ADetailer** — up to 3 independent detection/inpaint passes (e.g. face + hands)
- **Soft Inpainting** — seamless blending of inpainted regions (requires Soft Inpainting script)
- **Aspect ratio presets** — quick base resolution and ratio buttons with landscape/portrait toggle
- **HSV color wheel** — full hue/saturation/value picker
- **Zoom & pan** — mousewheel zoom, middle-click or Alt+drag to pan
- **Undo/Redo** — per-layer history (up to 30 steps)
- **Settings transfer** — "Send to Studio" bridge buttons in txt2img and img2img tabs carry over prompts and generation parameters
- **Interrupt and Skip** buttons for live generation control
- **Outputs saved** to separate subfolders by mode (`outputs/studio/create`, `outputs/studio/edit`, etc.)

---

## Installation

1. Clone or download this repository into your Forge extensions folder:

```
stable-diffusion-webui-forge/extensions/forge-studio/
```

2. Restart the WebUI. The **Studio** tab will appear in the main navigation.

No Python dependencies need to be installed — `install.py` is a no-op.

---

## Requirements

- [Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge)
- **ADetailer** (optional) — install the [ADetailer extension](https://github.com/Bing-su/adetailer) and its models if you want to use the ADetailer slots
- **Soft Inpainting** — included with Forge by default; just enable it in the Edit Settings accordion

---

## Usage

### Modes

| Mode | Description |
|------|-------------|
| **Create** | Sketch on a blank or reference canvas, then generate from your drawing |
| **Edit** | Load an image and paint a mask to inpaint specific regions |
| **img2img** | Use the canvas image directly as an img2img source (no drawing tools) |

### Canvas Workflow

1. **Load Image** — click "📂 Load Image" in the layers panel or use a bridge button from another tab. The canvas resizes automatically to the image dimensions.
2. **Draw** — use the toolbar brushes on the active layer. Switch between Sketch, Reference, and Inpaint layers using the layer buttons.
3. **Generate** — set your prompt, adjust settings, and click **Generate**. Results appear in the output gallery on the right.
4. **Result → Reference** — send the last generated image back to the Reference layer for iterative refinement.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `B` | Brush |
| `E` | Eraser |
| `S` | Smudge |
| `R` | Blur |
| `G` | Fill |
| `I` | Eyedropper |
| `[` / `]` | Decrease / Increase brush size |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `F` | Fit canvas to view |
| `0` | Reset zoom to 100% |
| `Shift+Enter` (in prompt) | Trigger generation |

### Canvas Navigation

- **Scroll wheel** — zoom in/out (centered on cursor)
- **Middle click + drag** or **Alt + left drag** — pan

### ADetailer

Enable one or more slots in the **ADetailer** accordion. Each slot runs independently after the main generation pass. Useful for e.g. Slot 1 = face model, Slot 2 = hand model. Leave the prompt fields blank to inherit the main prompt.

### Hires Fix

Enable in the **Hires Fix** accordion. The image is first upscaled with the chosen upscaler, then a second img2img pass is run at the target resolution. Set **Hires steps** to 0 to use the same step count as the main pass; set **Hires CFG** to 0 to inherit the main CFG.

### Soft Inpainting

Available in **Edit Settings** when in Edit mode. Blends the inpainted region smoothly into the surrounding image using mask opacity. Works best with higher Mask blur values. Requires the Soft Inpainting script (bundled with Forge).

---

## File Structure

```
forge-studio/
├── install.py               # No-op (no dependencies)
├── style.css                # Imports css/studio.css
├── studio.py                # Legacy entry point (Build B)
├── css/
│   └── studio.css           # All UI styles
├── javascript/
│   └── studio.js            # Canvas engine, toolbar, bridge buttons
└── scripts/
    └── studio.py            # Main extension script (Gradio UI + generation logic)
```

---

## Known Limitations

- Generation preview is not live (no intermediate step preview); results appear only after the full run completes.
- The canvas undo history is cleared when the canvas is resized or an image is loaded.
- ADetailer and Soft Inpainting require their respective extensions/scripts to be present in Forge; Studio will skip them gracefully if unavailable.

---

## License

See `LICENSE.txt` for full terms.
