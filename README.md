# Forge Studio v1.0

**A standalone creative workspace for [Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge).**

By **ToxicHost** & **Moritz**

---

Forge Studio replaces the scattered img2img workflow with a single unified tab. Paint, inpaint, sketch, and generate — all without leaving the canvas.

## Features

### Three Modes

- **Create** — A blank canvas or loaded reference image. Paint with full color tools, then generate. Works like img2img Sketch: your strokes composite with the reference and the result is img2img'd at your chosen denoising strength.

- **Edit** — Load an image, then choose between two sub-modes:
  - **Inpaint** — Paint a red mask over areas to regenerate. The masked region is replaced; everything else stays.
  - **Inpaint Sketch** — Paint colored strokes directly on the image to guide regeneration. The color of your strokes influences the output (best results at denoising 0.3–0.6). Mask is automatically derived from your stroke coverage.

- **img2img** — Load an image and generate directly. No painting tools, just standard img2img with your loaded reference.

### Canvas & Drawing Tools

- **Brush** — Round, Flat, Scatter, and Marker presets with adjustable size (1–200), opacity, hardness, and smoothing
- **Eraser** — Removes strokes from the active layer
- **Smudge** — Blends colors on the canvas (Create / Inpaint Sketch modes)
- **Blur** — Softens areas with adjustable strength (Create / Inpaint Sketch modes)
- **Fill** — Flood-fills connected areas with the current color (Create / Inpaint Sketch modes)
- **Eyedropper** — Picks color from the canvas (Create / Inpaint Sketch modes)
- **HSV Color Wheel** — Click the color swatch to open a hue wheel + saturation/value picker with numeric H/S/V inputs
- **Color Swatches** — 8 quick-access colors plus a 10-color recent history
- **Symmetry** — Horizontal, vertical, or both-axis mirroring for strokes
- **Pen Pressure** — Toggle pressure sensitivity affecting size, opacity, or both

### Zoom & Pan

- **Scroll wheel** to zoom in/out (0.1x – 16x)
- **Right-click drag** or **middle-click drag** to pan
- **Alt + left-click drag** to pan
- **Double-click** to reset zoom (via keyboard: `0`)

### Aspect Ratio Buttons

Inspired by the [Aspect Randomizer](https://github.com/MoelworkEM/sd-forge-ar) extension by Moritz:

- **Base sizes**: 512, 640, 768 (default), 896, 1024
- **Ratios**: 1:1, 5:4, 4:3, 3:2, 16:9, 2:1
- **Orientation toggle**: Landscape ↔ Portrait
- **Swap** (⇔): Flip width and height
- **Lock** (🔒): Lock the current ratio — width changes automatically adjust height

### Built-in ADetailer (3 Slots)

Three independent ADetailer slots with per-slot settings:

- Model selection (face, hand, person detection)
- Confidence threshold
- Denoising strength
- Mask blur & inpaint padding
- Per-slot prompt and negative prompt overrides

No external ADetailer extension required — detection and inpainting run natively.

### Built-in Hires Fix

- Upscaler selection (all installed upscalers available)
- Scale factor
- Hires steps, denoising, and CFG

### Send to Studio

Bridge buttons (🎨) appear in txt2img and img2img output areas. Clicking sends:

- The generated image as the canvas reference
- Prompt and negative prompt
- Steps, CFG scale, denoising strength, seed
- Sampler and schedule type

### Layers (Create Mode)

- **Sketch** — Your painted strokes
- **Reference** — The background/loaded image
- Each layer has independent visibility toggles
- Clear Layer / Reset All buttons

### Resolution Behavior

- **Create mode**: Width/Height sliders resize the canvas
- **Edit / img2img modes**: Width/Height sliders set output resolution only — the canvas stays at the loaded image's dimensions to prevent warping

### Soft Inpainting

Available as a toggle under Edit Settings when using Inpaint or Inpaint Sketch modes. Soft Inpainting seamlessly blends original content with inpainted content using mask opacity, producing smoother transitions at mask boundaries. Particularly useful for Inpaint Sketch where color blending matters.

**Settings:**
- **Schedule bias** (default 1.0) — Shifts when preservation of original content occurs during denoising
- **Preservation strength** (default 0.5) — How strongly partially masked content should be preserved
- **Transition contrast boost** (default 4.0) — Amplifies contrast that may be lost in partially masked regions

Recommended to use with higher Mask blur values for best results.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `B` | Brush tool |
| `E` | Eraser tool |
| `G` | Fill tool (Create / Inpaint Sketch) |
| `I` | Eyedropper tool (Create / Inpaint Sketch) |
| `S` | Smudge tool (Create / Inpaint Sketch) |
| `R` | Blur tool (Create / Inpaint Sketch) |
| `[` | Decrease brush size |
| `]` | Increase brush size |
| `F` | Fit canvas to viewport |
| `0` | Reset zoom to 100% |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Shift+Enter` | Generate (while focused in prompt) |

## Installation

### From folder

```
cd stable-diffusion-webui-forge/extensions
git clone <repo-url> sd-forge-studio
```

Or extract the release archive into your `extensions/` directory.

### From archive

1. Download `sd-forge-studio.tar.gz`
2. Extract into `extensions/`:
   ```
   cd stable-diffusion-webui-forge/extensions
   tar -xzf sd-forge-studio.tar.gz
   ```
3. Restart Forge

The **Studio** tab will appear alongside txt2img and img2img.

## File Structure

```
sd-forge-studio/
├── scripts/
│   └── studio.py          # Backend: generation, ADetailer, Hires Fix
├── javascript/
│   └── studio.js          # Frontend: canvas, tools, zoom, AR, bridge
├── css/
│   └── studio.css         # Toolbar and canvas styling
├── style.css              # Gradio theme overrides
├── install.py             # Dependency check
└── README.md
```

## Tips

- **Inpaint Sketch colors work best at denoising 0.3–0.6.** At higher values, the model increasingly ignores the init image (and your colors). At 1.0, colors have no effect — this is standard diffusion behavior, not a bug.
- **Use prompt reinforcement with Inpaint Sketch.** Painting pink on the eyes AND adding "pink eyes" to the prompt produces much better results than paint alone.
- **The AR lock is useful for iterating.** Lock a ratio, then change the base size — height adjusts automatically.
- **Right-click to pan** is the fastest way to navigate a zoomed canvas. Double-click to snap back to 1:1.

## Credits

- **ToxicHost** — Extension development
- **Moritz** — Aspect ratio system, collaboration, and testing

## License

MIT
