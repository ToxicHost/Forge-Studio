/**
 * Forge Studio — Codex Module
 * by ToxicHost & Moritz
 *
 * In-app reference documentation. Searchable, with optional collapsible
 * technical deep-dives per entry. Task-oriented structure.
 *
 * Content model:
 *   content  — main body (clear, accessible to all skill levels)
 *   deep     — optional collapsible "Under the Hood" (technical detail)
 *
 * Registers via StudioModules.register("codex", {...})
 */
(function () {
"use strict";
var TAG = "[Codex]", VERSION = "2.0.0";

// ══════════════════════════════════════════════════════════════════
// CATEGORIES
// ══════════════════════════════════════════════════════════════════

var CATEGORIES = [
  { id: "getting_started",  label: "Getting Started" },
  { id: "how_studio_works", label: "How Studio Works" },
  { id: "canvas_tools",     label: "Canvas Tools" },
  { id: "generation",       label: "Generation" },
  { id: "inpainting",       label: "Inpainting" },
  { id: "advanced",         label: "Advanced Features" },
  { id: "layers",           label: "Layers & Export" },
  { id: "gallery",          label: "Gallery" },
  { id: "comic_lab",        label: "Comic Lab" },
  { id: "troubleshooting",  label: "Troubleshooting" },
  { id: "shortcuts",        label: "Keyboard Shortcuts" },
];

// ══════════════════════════════════════════════════════════════════
// ENTRIES
// ══════════════════════════════════════════════════════════════════

var ENTRIES = [

  // ── GETTING STARTED ────────────────────────────────────────────

  { id: "core_workflow", title: "The Core Workflow", category: "getting_started",
    tags: ["workflow", "basics", "generate", "paint", "iterate", "loop"],
    content: "<p>Forge Studio\u2019s workflow is a loop: <strong>describe \u2192 generate \u2192 paint \u2192 iterate</strong>.</p><p>Type what you want to see in the prompt box, hit Generate, and the AI creates an image on your canvas. From there, you can paint on top of it, then generate again \u2014 the AI works with whatever is already on the canvas.</p><p>You\u2019re building images with your hands and the AI together. Every generation can be a starting point, a refinement, or a complete reimagining.</p>",
    deep: "<p>Studio auto-routes based on canvas state: blank canvas \u2192 txt2img, canvas with content \u2192 img2img, mask painted \u2192 inpainting. The function <code>isCanvasBlank()</code> is the sole source of truth for this routing \u2014 it checks actual pixel data, not a dirty flag. Denoise strength controls how much the AI changes existing content (1.0 = full replace, 0.3 = gentle refinement).</p>",
  },

  { id: "first_image", title: "Making Your First Image", category: "getting_started",
    tags: ["first", "prompt", "generate", "beginner"],
    content: "<p>1. Type a description in the <strong>prompt box</strong> \u2014 \"a cat on a mountain at sunset\" works fine.</p><p>2. Click <em>Generate</em> (or <span class=\"cx-kbd\">Ctrl+Enter</span>).</p><p>3. Wait a few seconds. Your image appears in the output gallery.</p><p>4. Click <em>Result \u2192 Canvas</em> to place it on the canvas for editing.</p><p>Every image is unique \u2014 same prompt, different seed, different result. Try generating a few times to see the variety.</p>",
  },

  { id: "ui_layout", title: "UI Layout", category: "getting_started",
    tags: ["layout", "interface", "panels", "toolbar", "orientation"],
    content: "<p><strong>Left:</strong> Toolstrip \u2014 your painting tools (brush, eraser, fill, and 16 more).</p><p><strong>Center:</strong> Canvas \u2014 scroll to zoom, Space+drag to pan. This is where your image lives.</p><p><strong>Right:</strong> Panel \u2014 three tabs: Generate (prompt, settings, output), Extensions (ControlNet, ADetailer), and Settings. <span class=\"cx-kbd\">\\</span> collapses it for more canvas space.</p><p><strong>Top:</strong> Context bar \u2014 shows controls for whichever tool is active (size, opacity, hardness, etc.).</p><p><strong>Bottom:</strong> Status bar \u2014 generation progress, VRAM usage, canvas dimensions.</p><p><strong>Tab bar:</strong> Switch between Studio (canvas), Gallery, Workshop, Comic Lab, and Codex (you\u2019re here).</p>",
  },

  { id: "models_and_vae", title: "Models & VAE", category: "getting_started",
    tags: ["model", "checkpoint", "vae", "sdxl", "sd15", "load", "download", "install", "illustrious", "flux", "gguf", "fp8", "fp16", "architecture"],
    content: "<p>The <strong>model</strong> (also called a checkpoint) is the AI brain that generates your images. Without one, Studio can\u2019t generate anything. Different models produce completely different styles \u2014 photorealistic, anime, painterly, abstract.</p><hr class=\"cx-divider\"><p><strong>Getting your first model:</strong></p><p>1. Download a model file. Here\u2019s a good one to start with: <a href=\"https://pixeldrain.com/u/5pv797g8\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">ToxicHost\u2019s recommended starter model</a></p><p>2. Put the downloaded file in your Forge folder: <code>models/Stable-diffusion/</code></p><p>3. In Studio, click the refresh button (\u21bb) next to the Model dropdown. Your model appears \u2014 no restart needed.</p><p>4. Select it from the dropdown. <strong>Make sure the architecture selector</strong> (radio buttons: SD 1.5 / XL / Flux) matches your model \u2014 wrong architecture = errors.</p><p>Find more models on <a href=\"https://civitai.com\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">CivitAI</a> (checkpoints, LoRAs, community content) and <a href=\"https://huggingface.co\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">Hugging Face</a> (official releases).</p><hr class=\"cx-divider\"><p><strong>Architectures:</strong></p><p>\u2022 <strong>SD 1.5</strong> \u2014 smaller, faster, huge ecosystem. ~4 GB VRAM.</p><p>\u2022 <strong>SDXL / Illustrious</strong> \u2014 higher quality, more VRAM (6\u20137 GB). Illustrious models excel at anime and illustration styles.</p><p>\u2022 <strong>Flux</strong> \u2014 newer architecture with different prompt handling. Needs separate text encoders.</p><p>SD1.5, SDXL, and Flux checkpoints, LoRAs, and ControlNet models are <strong>not cross-compatible</strong>.</p><hr class=\"cx-divider\"><p><strong>Model formats:</strong></p><p>\u2022 <code>.safetensors</code> \u2014 standard, always prefer this.</p><p>\u2022 <code>.gguf</code> \u2014 quantized, uses less VRAM at some quality cost. Good for larger models on smaller GPUs.</p><p>\u2022 <strong>fp16 / fp8</strong> \u2014 numerical precision. Lower = less VRAM, slightly less quality. fp16 is the sweet spot for most. Set \"Diffusion in Low Bits\" to \"Automatic\" for fp8/GGUF models.</p><hr class=\"cx-divider\"><p><strong>VAE:</strong> The VAE handles color processing. Leave it on \"Automatic\" \u2014 most models include their own. If your colors look washed out or oversaturated, try switching to a specific VAE from the dropdown.</p>",
    deep: "<p>Model dropdown pulls from Forge\u2019s checkpoint directory. Hot-reload via refresh button \u2014 no restart. VAE \"Automatic\" uses baked-in or Forge global. For SD1.5 color issues try <code>vae-ft-mse-840000</code>. SDXL uses dual text encoders (CLIP-L + CLIP-G). Flux may require separate text encoder downloads. Some models need keywords in their path to be recognized (e.g. Flux-Kontext needs \"kontext\" in the filename).</p>",
  },

  { id: "output_workflow", title: "Saving & Using Results", category: "getting_started",
    tags: ["output", "save", "result", "canvas", "gallery", "format", "defaults", "persist", "server"],
    content: "<p>Generated images appear in the <strong>output gallery</strong> strip at the bottom of the Generate panel.</p><p><em>Result \u2192 Canvas</em> places the image on your canvas as a new layer \u2014 it doesn\u2019t overwrite your existing work. Pipeline results (generation, upscale) go to a reusable \"Gen Result\" layer.</p><p><em>Save</em> writes to disk (auto-save is on by default). You can change the format in Settings: PNG, JPEG, or WebP. <em>Embed metadata</em> stores your prompt and settings inside saved files so you can recreate them later.</p><hr class=\"cx-divider\"><p><strong>Workflow defaults:</strong> Save your current parameter settings (sampler, scheduler, CFG, steps, denoise, and more) as defaults via Settings \u2192 Defaults \u2192 <em>Save Current as Defaults</em>. These persist <strong>server-side</strong> and load automatically on next launch. Separate from per-tool brush settings, which are client-side.</p>",
  },

  { id: "color_picker", title: "Color Picker", category: "getting_started",
    tags: ["color", "picker", "hsv", "hex", "swatch"],
    content: "<p>Click the toolstrip swatches to open the color picker. HSV wheel + hex input for precise colors.</p><p><span class=\"cx-kbd\">X</span> swaps foreground and background colors. <span class=\"cx-kbd\">D</span> resets them to black and white.</p><p><span class=\"cx-kbd\">Ctrl+Click</span> on the canvas samples a color from any tool without switching away. <span class=\"cx-kbd\">I</span> switches to the dedicated eyedropper tool.</p><p>Studio keeps a rolling history of your last 10 colors as clickable swatches below the picker.</p>",
  },

  // ── HOW STUDIO WORKS ───────────────────────────────────────────

  { id: "canvas_routing", title: "Canvas Routing", category: "how_studio_works",
    tags: ["routing", "txt2img", "img2img", "auto", "mode", "blank", "zoom", "pixel", "nearest"],
    content: "<p>Studio doesn\u2019t have separate txt2img and img2img tabs. You paint on the canvas, hit Generate, and Studio checks the pixels to decide the routing:</p><p>\u2022 <strong>Canvas is blank</strong> \u2192 txt2img (generates from scratch)</p><p>\u2022 <strong>Canvas has content</strong> \u2192 img2img (works with what\u2019s there)</p><p>\u2022 <strong>Mask painted</strong> \u2192 inpainting (changes only the masked area)</p><p>You never pick a mode. The canvas state <em>is</em> the mode. If you sketch something, erase it all, and generate \u2014 that\u2019s txt2img, because the canvas is blank. The pixels are the source of truth, not a mode toggle.</p><hr class=\"cx-divider\"><p><strong>Zoom behavior:</strong> At 200%+ zoom, pixels render crisp (nearest-neighbor) instead of blurry. Below 200%, standard bilinear smoothing applies. This matches Krita\u2019s behavior and makes pixel-level editing clean.</p>",
    deep: "<p><code>isCanvasBlank()</code> checks actual pixel data on every generation call. It\u2019s the sole source of truth for routing \u2014 no dirty flags or mode toggles involved. A completely transparent canvas routes to txt2img. Any non-transparent pixel routes to img2img. Mask presence is checked separately and takes priority.</p>",
  },

  { id: "scrub_labels", title: "Scrub Labels", category: "how_studio_works",
    tags: ["scrub", "slider", "context", "bar", "drag", "adjust"],
    content: "<p>The context bar values (Size, Opacity, Hardness, Smoothing, Strength) aren\u2019t traditional sliders \u2014 they\u2019re <strong>scrub labels</strong>:</p><p>\u2022 <strong>Drag horizontally</strong> on the label to adjust the value (like Photoshop\u2019s scrubby sliders).</p><p>\u2022 <strong>Click</strong> the label to open a text input and type an exact number.</p><p>Sensitivity scales to the value range \u2014 fine controls (like hardness 0\u20131) scrub slower than coarse ones (like size 1\u2013100). You\u2019ll get used to these fast.</p>",
  },

  { id: "per_tool_memory", title: "Per-Tool Settings Memory", category: "how_studio_works",
    tags: ["tool", "settings", "memory", "remember", "persist", "independent"],
    content: "<p>Each brush-type tool (brush, eraser, smudge, blur, dodge, clone, liquify, shape) <strong>remembers its own settings independently</strong>. Size, opacity, hardness, smoothing, and strength are stored per-tool.</p><p>Switch from brush to eraser and back \u2014 your brush settings are exactly where you left them. These persist across sessions via local storage.</p>",
  },

  { id: "shift_drag_resize", title: "Shift+Drag Brush Resize", category: "how_studio_works",
    tags: ["shift", "drag", "resize", "brush", "opacity", "krita"],
    shortcut: "Shift+Drag",
    content: "<p>Hold <span class=\"cx-kbd\">Shift</span> and drag on the canvas: <strong>horizontal movement</strong> adjusts brush size, <strong>vertical movement</strong> adjusts opacity. Krita-style.</p><p>Works for brush, eraser, smudge, blur, dodge, clone, and liquify. Much faster than reaching for the context bar or using bracket keys.</p>",
  },

  { id: "drag_and_drop", title: "Drag & Drop", category: "how_studio_works",
    tags: ["drag", "drop", "image", "load", "import", "file"],
    content: "<p>Drop an image file onto the canvas and Studio:</p><p>1. Resizes the canvas to match the image dimensions.</p><p>2. Creates a new layer with the image.</p><p>3. Updates width/height inputs and AR indicator.</p><p>4. Reads PNG metadata and imports generation parameters if found (prompt, seed, settings).</p><p>5. Disables Hires Fix automatically (since you\u2019re loading an existing image).</p><p>This is the fastest way to bring an external image into Studio for editing or img2img.</p>",
  },

  { id: "send_to_canvas", title: "Send to Canvas", category: "how_studio_works",
    tags: ["result", "canvas", "output", "layer", "send"],
    content: "<p>Sending an output to the canvas (button, right-click, or drag from the output strip) creates a <strong>new layer</strong> \u2014 it doesn\u2019t overwrite your work.</p><p>Pipeline results (generation, upscale) go to a reusable \"Gen Result\" layer. Gallery sends also create new layers. Your painted edits on other layers are always safe.</p>",
  },

  { id: "ar_buttons", title: "Aspect Ratio Buttons", category: "how_studio_works",
    tags: ["aspect", "ratio", "resolution", "base", "swap", "random", "pool"],
    content: "<p>The AR buttons have interactive behavior beyond simple presets:</p><p>\u2022 <strong>Click a ratio</strong> \u2192 applies it and resizes the canvas.</p><p>\u2022 <strong>Re-click the active ratio</strong> \u2192 swaps portrait/landscape (e.g. 3:2 becomes 2:3).</p><p>\u2022 Both actions are <strong>undoable</strong> \u2014 Ctrl+Z restores the previous canvas and dimensions.</p><hr class=\"cx-divider\"><p>When <em>AR Randomization</em> is enabled, the buttons switch to pool-toggle mode \u2014 click to include/exclude ratios from the random pool instead of applying them directly. Same behavior for base resolution buttons.</p>",
  },

  // ── CANVAS TOOLS ───────────────────────────────────────────────

  { id: "tool_brush", title: "Brush", category: "canvas_tools",
    tags: ["brush", "paint", "draw", "dynamics", "preset"], shortcut: "B",
    content: "<p>Your primary painting tool. Adjust <em>Size</em>, <em>Opacity</em>, and <em>Hardness</em> in the context bar. Hardness controls edge softness \u2014 100% is a sharp circle, lower values give a softer, airbrushed look. <em>Smoothing</em> stabilizes your strokes for cleaner curves. <span class=\"cx-kbd\">[</span>/<span class=\"cx-kbd\">]</span> to resize quickly.</p><hr class=\"cx-divider\"><p><strong>Five presets</strong>, each suited to different tasks:</p><p>\u2022 <strong>Round</strong> \u2014 general purpose, clean edges. Your default for most painting.</p><p>\u2022 <strong>Flat</strong> \u2014 wide strokes with angle sensitivity. Good for broad fills and gradients.</p><p>\u2022 <strong>Scatter</strong> \u2014 textured spray of particles. Use for foliage, gravel, stars, or organic noise.</p><p>\u2022 <strong>Marker</strong> \u2014 firm edge with slight texture. Good for linework and outlines.</p><p>\u2022 <strong>Custom</strong> \u2014 load your own grayscale brush tip image.</p><hr class=\"cx-divider\"><p><strong>Pressure sensitivity:</strong> Pen pressure toggles with <strong>S</strong> (pressure \u2192 size) and <strong>O</strong> (pressure \u2192 opacity). The <strong>Brush Dynamics</strong> panel (gear icon) exposes spacing, size jitter, opacity jitter, scatter, and rotation jitter.</p>",
    deep: "<p>The opacity model uses a wet buffer \u2014 stamps draw at full opacity into a per-stroke buffer, and the completed stroke composites at the opacity ceiling. This prevents accumulation artifacts within a single stroke, matching Photoshop\u2019s behavior. Brush dynamics include: spacing (fraction of diameter between stamps), size jitter, opacity jitter, scatter (random offset), rotation jitter, and follow-stroke rotation. Elliptical ratio and stipple/spike tips use Gaussian falloff via <code>erf()</code>.</p>",
  },

  { id: "tool_eraser", title: "Eraser", category: "canvas_tools",
    tags: ["eraser", "erase", "delete", "transparent"], shortcut: "E",
    content: "<p>Removes paint, making pixels transparent. On the background/reference layer, fills with white instead. Same controls and presets as the brush \u2014 size, opacity, hardness, dynamics all work the same way.</p>",
  },

  { id: "tool_eyedropper", title: "Eyedropper", category: "canvas_tools",
    tags: ["eyedropper", "color", "pick", "sample", "average", "radius"], shortcut: "I",
    content: "<p>Click to sample a color from the canvas. Shortcut: <span class=\"cx-kbd\">Ctrl+Click</span> from any brush tool samples without switching away.</p><p>Supports configurable <strong>radius averaging</strong> \u2014 instead of picking a single pixel, it averages an area around the sample point. Useful for getting a representative color from textured or noisy AI-generated regions.</p>",
  },

  { id: "tool_smudge", title: "Smudge", category: "canvas_tools",
    tags: ["smudge", "blend", "mix"], shortcut: "S",
    content: "<p>Blends colors like wet paint. <em>Strength</em> controls how much color gets picked up and dragged. Particularly useful for softening AI-generated edges that look too sharp \u2014 skin boundaries, hair edges, clothing folds. Strength around 30\u201350% gives the most controllable results.</p>",
  },

  { id: "tool_blur", title: "Blur", category: "canvas_tools",
    tags: ["blur", "soften", "smooth"], shortcut: "R",
    content: "<p>Paints softness. Good for smoothing skin, softening backgrounds, or reducing noise in specific areas without affecting the whole image.</p>",
  },

  { id: "tool_dodge_burn", title: "Dodge / Burn", category: "canvas_tools",
    tags: ["dodge", "burn", "lighten", "darken", "lighting"], shortcut: "J",
    content: "<p><strong>Dodge</strong> lightens, <strong>Burn</strong> darkens. Toggle between them in the context bar. Adjusts lighting without changing the underlying colors \u2014 great for adding depth, shadows, highlights, or correcting uneven lighting in generated images.</p>",
  },

  { id: "tool_clone", title: "Clone Stamp", category: "canvas_tools",
    tags: ["clone", "stamp", "copy", "remove", "fix", "patch"], shortcut: "K",
    content: "<p>Copies pixels from one part of the canvas to another. Here\u2019s how to use it:</p><p>1. Hold <span class=\"cx-kbd\">Alt</span> and click on a <em>clean area</em> near the thing you want to remove. This sets the source point.</p><p>2. Now paint over the unwanted object. The tool copies pixels from the source area as you paint, covering the object with matching content.</p><p>3. The source point follows your brush \u2014 it moves relative to where you paint. If the clone starts picking up wrong content, <span class=\"cx-kbd\">Alt</span>+click a new source.</p><p>Works great for removing watermarks, erasing unwanted objects, duplicating elements, or patching artifacts in generated images.</p>",
  },

  { id: "tool_liquify", title: "Liquify", category: "canvas_tools",
    tags: ["liquify", "warp", "distort", "push", "anatomy"], shortcut: "Y",
    content: "<p>Pushes and warps pixels. Drag to distort the image in the direction you move. Great for adjusting proportions and fixing AI anatomy issues.</p><p>Use a <strong>large brush</strong> for broad adjustments (shoulder width, head tilt), <strong>small brush</strong> for fine-tuning (eye positions, jawlines, hand proportions). The distortion applies on stroke end.</p>",
  },

  { id: "tools_drawing", title: "Fill, Gradient, Shape & Text", category: "canvas_tools",
    tags: ["fill", "gradient", "shape", "text", "font", "rectangle", "ellipse", "line"], shortcut: "G / U / T",
    content: "<p><strong>Fill</strong> <span class=\"cx-kbd\">G</span> \u2014 flood-fills an area with the foreground color.</p><p><strong>Gradient</strong> <span class=\"cx-kbd\">G</span> again \u2014 draws a smooth transition from foreground to background color. Linear or radial.</p><p><strong>Shape</strong> <span class=\"cx-kbd\">U</span> \u2014 rectangle, ellipse, or line. Fill or outline mode. Hold <span class=\"cx-kbd\">Shift</span> for perfect squares/circles.</p><p><strong>Text</strong> <span class=\"cx-kbd\">T</span> \u2014 click to place, choose font and size. Renders to pixels on commit.</p>",
  },

  { id: "tools_selection", title: "Selection Tools", category: "canvas_tools",
    tags: ["select", "marquee", "lasso", "polylasso", "maglasso", "magnetic", "wand", "magic"], shortcut: "M / O / L / W",
    content: "<p>Create selections to constrain painting, generation, or clipboard operations to a specific area.</p><p>\u2022 <span class=\"cx-kbd\">M</span> <strong>Rectangular</strong> \u2014 click and drag a box.</p><p>\u2022 <span class=\"cx-kbd\">O</span> <strong>Elliptical</strong> \u2014 click and drag an oval. <span class=\"cx-kbd\">Shift</span> constrains to circle.</p><p>\u2022 <span class=\"cx-kbd\">L</span> <strong>Lasso</strong> \u2014 freehand selection. Three modes via context bar subtool buttons: freehand lasso, polygon lasso (click-to-click straight segments), and magnetic lasso (snaps to edges).</p><p>\u2022 <span class=\"cx-kbd\">W</span> <strong>Magic Wand</strong> \u2014 selects similar-colored areas. <em>Strength</em> controls tolerance.</p><hr class=\"cx-divider\"><p><span class=\"cx-kbd\">Ctrl+D</span> deselect \u2022 <span class=\"cx-kbd\">Ctrl+A</span> select all \u2022 <span class=\"cx-kbd\">Ctrl+Shift+I</span> invert \u2022 <span class=\"cx-kbd\">Ctrl+C/X/V</span> clipboard \u2022 <span class=\"cx-kbd\">Delete</span> clear selection.</p>",
    deep: "<p>The magnetic lasso uses Sobel edge detection combined with Dijkstra\u2019s shortest-path algorithm to find the strongest edge path between anchor points. It snaps to high-contrast boundaries in the image, making it much faster than freehand for complex organic shapes.</p>",
  },

  { id: "tool_crop", title: "Crop", category: "canvas_tools",
    tags: ["crop", "resize", "trim", "aspect", "preset"], shortcut: "C",
    content: "<p>Trims the canvas to a selected region. Drag the crop box, then press <span class=\"cx-kbd\">Enter</span> to apply or <span class=\"cx-kbd\">Escape</span> to cancel.</p><p>The context bar offers <strong>AR-matching presets</strong> \u2014 common aspect ratios that snap the crop box to exact proportions. Useful for preparing images for specific output sizes.</p>",
  },

  { id: "tool_transform", title: "Transform", category: "canvas_tools",
    tags: ["transform", "move", "scale", "rotate", "perspective", "warp"], shortcut: "V",
    content: "<p>Move, scale, and rotate the current layer or selection. Drag handles to resize, drag inside to move. <span class=\"cx-kbd\">Enter</span> applies, <span class=\"cx-kbd\">Escape</span> cancels, <span class=\"cx-kbd\">Shift</span> constrains proportions.</p><hr class=\"cx-divider\"><p><strong>Warp modes</strong> (available in context bar when transform is active):</p><p>\u2022 <strong>Affine</strong> \u2014 move control points freely. Most flexible deformation.</p><p>\u2022 <strong>Similitude</strong> \u2014 preserves angles (no skew). Scale + rotate only.</p><p>\u2022 <strong>Rigid</strong> \u2014 preserves distances as much as possible. Minimal distortion, good for repositioning elements naturally.</p><p>\u2022 <strong>Perspective</strong> \u2014 four-corner pin for perspective correction or deliberate perspective distortion.</p><p>All warp modes use Moving Least Squares (MLS) interpolation for smooth, natural-looking deformations. Grid subdivision renders the transformed result at high quality.</p>",
    deep: "<p>The MLS warp implementation follows the Schaefer, McPhail &amp; Warren paper with three deformation types (Affine, Similitude, Rigid). Grid subdivision renders the warp by tessellating the canvas into a grid and transforming each cell, avoiding the visual artifacts that per-pixel sampling would produce. The perspective transform uses standard 4-point homography. Algorithms ported from Krita\u2019s GPL-3.0 source (<code>tool_transform2/</code>), which is license-compatible with Studio\u2019s AGPL-3.0 via Section 13.</p>",
  },

  { id: "tool_radial_symmetry", title: "Symmetry Painting", category: "canvas_tools",
    tags: ["symmetry", "radial", "mirror", "kaleidoscope", "mandala", "horizontal", "vertical"],
    content: "<p>Studio supports three symmetry modes, toggled from the context bar buttons:</p><p>\u2022 <strong>Horizontal</strong> \u2014 mirrors strokes left/right across a vertical center line.</p><p>\u2022 <strong>Vertical</strong> \u2014 mirrors strokes top/bottom across a horizontal center line.</p><p>\u2022 <strong>Radial</strong> \u2014 replicates strokes around a center point with configurable axis count. Set 2 for simple mirror, 6+ for snowflake/kaleidoscope patterns, 8+ for mandala designs.</p><p>Works with brush, eraser, and smudge. In radial mode, each symmetry segment maintains its own <strong>independent smudge buffer</strong> so smudge strokes don\u2019t bleed between segments.</p><p>Combined mode (horizontal + vertical) gives four-way symmetry.</p>",
  },

  // ── GENERATION ─────────────────────────────────────────────────

  { id: "param_prompt", title: "Writing Effective Prompts", category: "generation",
    tags: ["prompt", "text", "describe", "token", "emphasis", "weight", "structure", "chunk", "break", "schedule", "and", "alternating"],
    content: "<p>Describe what you want to see in plain language. \"A red fox in a snowy forest\" works. So does \"portrait of a woman with gold earrings, oil painting style, cinematic lighting.\" More specific prompts give more controlled results.</p><hr class=\"cx-divider\"><p><strong>Structure:</strong> A good pattern is <em>subject first, then style, then quality</em>. For example: \"a knight standing on a cliff overlooking a valley, fantasy art, dramatic lighting, highly detailed.\" The AI pays the most attention to words near the beginning, so front-load what matters most.</p><hr class=\"cx-divider\"><p><strong>Emphasis:</strong> Control word strength with parentheses:</p><p><code>(important word:1.3)</code> \u2014 30% stronger. <code>(less important:0.7)</code> \u2014 30% weaker. Plain <code>(word)</code> defaults to 1.1. Nesting stacks: <code>((word))</code> = 1.21. Stay in the 0.5\u20131.5 range \u2014 extreme values cause artifacts. Use sparingly; overweighting everything defeats the purpose.</p><hr class=\"cx-divider\"><p><strong>BREAK:</strong> Forces a chunk boundary between sections. Useful for separating concepts that interfere with each other. A structured approach:</p><p><code>style, lighting, composition BREAK subject count BREAK detailed description, pose, background</code></p><p>Establishing \"how it looks\" before \"what it is\" helps consistent stylistic choices. Simple prompts don\u2019t need BREAK \u2014 it shines with complex, detailed generations.</p><hr class=\"cx-divider\"><p><strong>Token counter:</strong> The counter below the prompt shows token usage. The AI processes text in ~75-token chunks. Going past one chunk is fine, but words in later chunks may have less influence.</p><hr class=\"cx-divider\"><p><strong>Patterns that work well:</strong></p><p>\u2022 Quality tags: \"masterpiece, best quality, highly detailed\"</p><p>\u2022 Lighting: \"soft natural light,\" \"dramatic rim lighting,\" \"golden hour\"</p><p>\u2022 Camera: \"close-up portrait,\" \"wide shot,\" \"low angle,\" \"85mm lens\"</p><p>\u2022 Art styles: \"watercolor,\" \"oil painting,\" \"anime style,\" \"digital painting\"</p><p>\u2022 Specificity over vagueness: \"burgundy velvet dress\" beats \"nice dress\"</p><hr class=\"cx-divider\"><p><strong>Prompt troubleshooting:</strong></p><p>\u2022 <em>Wrong number of subjects:</em> Reinforce with <code>solo</code>. Move count tags earlier. Add <code>multiple girls</code> to negatives.</p><p>\u2022 <em>Style not coming through:</em> Front-load style tags. Use multiple related descriptors.</p><p>\u2022 <em>Background overwhelming subject:</em> Add <code>blurred background, bokeh, depth of field</code>. Move subject earlier.</p><p>\u2022 <em>Concepts bleeding together:</em> Add more BREAKs. Try prompt scheduling for staged introduction.</p>",
    deep: "<p><strong>Advanced syntax:</strong></p><p><em>Prompt Scheduling</em> <code>[from:to:when]</code> \u2014 transitions between concepts during generation. <code>when</code> is a decimal (fraction of steps) or integer (exact step). Example: <code>[sketch:finished rendering:0.5]</code> starts sketch-like, transitions to polished at 50%. Shorthand: <code>[to:when]</code> adds \"to\" after a step; <code>[from::when]</code> removes \"from\" after a step. Does NOT work with LoRA or Hypernetworks.</p><p><em>Prompt Alternating</em> <code>[concept|concept]</code> \u2014 alternates each step, creating blended effects. <code>[red hair|blonde hair]</code> produces strawberry blonde. <code>[rain|snow]</code> creates mixed precipitation. Does NOT work with LoRA or Hypernetworks.</p><p><em>Composable Diffusion</em> <code>AND</code> \u2014 processes prompts separately and combines results. <code>a portrait of a woman AND cyberpunk style</code>. Supports per-section weights: <code>a cat :1.2 AND a dog AND a penguin :2.2</code>. Commas = single combined concept; AND = separate processing then merge. Can cause \"overbaked\" results at high CFG \u2014 lower to ~5.</p><p><em>Escaping</em> \u2014 literal brackets with backslash: <code>anime_\\(character\\)</code>. Comments after <code>#</code> are ignored by some extensions.</p><p><em>Extra Networks</em> \u2014 <code>&lt;lora:filename:multiplier&gt;</code> and <code>&lt;hypernet:filename:multiplier&gt;</code> are processed and removed from the prompt before generation. Cannot be used in negative prompts or with scheduling/alternating.</p><p>Token counter shows per-encoder counts (CLIP-L and CLIP-G for SDXL) and chunk count. Multiple chunks work via prompt chunk concatenation \u2014 later chunks have full attention within themselves but reduced cross-chunk influence. Wildcard syntax <code>__wildcard_name__</code> resolved before encoding via dynamicprompts.</p>",
  },

  { id: "param_neg", title: "Negative Prompt", category: "generation",
    tags: ["negative", "prompt", "exclude", "avoid"],
    content: "<p>Tells the AI what to <strong>avoid</strong>. Common negatives: \"blurry, ugly, deformed, extra fingers, bad anatomy, watermark, text.\"</p><p>A few key words is usually enough \u2014 long negative prompts have diminishing returns. Only negate things you genuinely don\u2019t want. If you say \"red\" in positive and \"red\" in negative, they fight each other and you get muddy results.</p><p>Wildcards like <code>__neg4__</code> can insert pre-made negative templates if you have wildcard files installed.</p>",
    deep: "<p>CFG negative conditioning. Same syntax as positive (emphasis, BREAK, wildcards). Applied as the unconditional direction the model steers away from during each denoising step. Overly aggressive negatives reduce image quality \u2014 the model spends guidance budget avoiding things rather than building what you asked for.</p>",
  },

  { id: "param_cfg", title: "CFG Scale", category: "generation",
    tags: ["cfg", "guidance", "creativity", "adherence"],
    content: "<p>Controls how closely the AI follows your prompt. Higher values = more literal but can oversaturate. Lower values = more creative freedom.</p><hr class=\"cx-divider\"><p><strong>Recommended ranges by architecture:</strong></p><p>\u2022 <strong>SD 1.5:</strong> 7\u201311</p><p>\u2022 <strong>SDXL / Illustrious:</strong> 5\u20137</p><p>\u2022 <strong>Flux:</strong> 3.5\u20135</p><p>\u2022 <strong>Distilled models:</strong> 1.0 (guidance is baked into the distillation)</p><p>If your images look artificial, oversaturated, or have harsh colors, try lowering CFG first \u2014 it\u2019s the most common fix.</p>",
  },

  { id: "param_steps", title: "Steps", category: "generation",
    tags: ["steps", "quality", "speed", "iterations"],
    content: "<p>How many refinement passes the AI makes. More steps = more detail but takes longer.</p><p><strong>Sweet spot:</strong> 20\u201330. Use 15\u201320 when experimenting, 28\u201335 for polished finals. Above 40 rarely helps with most samplers.</p>",
    deep: "<p>Diminishing returns above ~30 for most samplers. DPM++ 2M SDE and Euler converge faster than ancestral samplers. Ancestral samplers (anything with \"a\" in the name) never fully converge \u2014 results change with every step count increment.</p>",
  },

  { id: "param_denoise", title: "Denoise Strength", category: "generation",
    tags: ["denoise", "strength", "img2img", "change", "canvas"],
    content: "<p>Controls how much the AI changes what\u2019s already on the canvas. Only matters when the canvas has content (img2img mode).</p><p>\u2022 <strong>1.0</strong> \u2014 full replace. Only prompt matters.</p><p>\u2022 <strong>0.7\u20130.8</strong> \u2014 major changes. Good for rough sketches.</p><p>\u2022 <strong>0.4\u20130.6</strong> \u2014 moderate. Adjusts while keeping structure.</p><p>\u2022 <strong>0.2\u20130.3</strong> \u2014 gentle. Refines details without altering composition.</p><p>Start high and lower it as you get closer to what you want.</p>",
    deep: "<p>Denoise maps to how many steps actually execute: 0.7 at 30 steps = 21 actual denoising steps. Auto-routing: blank+pristine canvas \u2192 txt2img, canvas with content \u2192 img2img, blank+dirty (erased) canvas \u2192 img2img.</p>",
  },

  { id: "param_sampler", title: "Sampler & Scheduler", category: "generation",
    tags: ["sampler", "scheduler", "karras", "dpm", "euler", "bfs"],
    content: "<p>The sampler controls the denoising algorithm. The scheduler controls how noise decreases across steps.</p><hr class=\"cx-divider\"><p><strong>Recommended starting points:</strong></p><p>\u2022 <strong>SD 1.5 / SDXL / Illustrious:</strong> Euler a or DPM++ 2M SDE + Karras</p><p>\u2022 <strong>Flux:</strong> Euler</p><p>\u2022 <strong>Distilled models:</strong> Euler (4\u20138 steps)</p><p>Don\u2019t stress about this early on \u2014 the difference is often subtle between samplers at the same step count.</p><hr class=\"cx-divider\"><p><strong>Ancestral vs non-ancestral:</strong> Samplers with \"a\" in the name (Euler a, DPM++ 2S a) are ancestral \u2014 they add randomness each step, producing more variety but never converging to a stable result. Non-ancestral samplers (DPM++ 2M, Euler) converge asymptotically \u2014 results stabilize as step count increases.</p>",
    deep: "<p>All Forge samplers available including bundled custom samplers: BFS (Bandwise Flow), Cacophony, Labyrinth, Parasite, Parasitic BFS, Grimoire, Adams-Bashforth. Custom \"Toxic\" scheduler uses a \u03c6\u00b3 power curve with progressive Karras blending.</p>",
  },

  { id: "param_dimensions", title: "Canvas Dimensions", category: "generation",
    tags: ["width", "height", "resolution", "aspect", "size", "portrait", "landscape"],
    content: "<p>Base buttons (512\u20131024) set the overall resolution. Ratio buttons set the shape (square, wide, tall). The <span class=\"cx-kbd\">\u21c4</span> button swaps orientation.</p><hr class=\"cx-divider\"><p><strong>Recommended resolutions:</strong></p><p>\u2022 <strong>SDXL / Illustrious:</strong> 1024\u00d71024 square. For portrait: 832\u00d71216. For landscape: 1216\u00d7832.</p><p>\u2022 <strong>SD 1.5:</strong> 512\u00d7512 or 768\u00d7768. Non-square: 512\u00d7768, 768\u00d7512.</p><p>\u2022 <strong>Flux:</strong> 1024\u00d71024 standard.</p><p>Going far below or above the model\u2019s native resolution without HiRes Fix can produce artifacts \u2014 duplicate limbs, distorted compositions. Use HiRes Fix for large, detailed output rather than generating at high resolution directly.</p><p>Bigger images take more VRAM and longer to generate.</p>",
  },

  { id: "param_seed_batch", title: "Seed & Batch", category: "generation",
    tags: ["seed", "random", "batch", "variation", "dice", "recycle"],
    content: "<p><strong>Seed:</strong> -1 = random (dice button). Same seed + same settings = same image. Click the recycle button to lock the seed and make variations by tweaking prompts or other settings.</p><p><em>Extra \u2192 Variation Seed</em> lets you blend between two seeds for subtle variations.</p><p><strong>Batch Count:</strong> generates multiple images sequentially, each with a different seed. <strong>Batch Size:</strong> generates multiple simultaneously (uses more VRAM).</p>",
  },

  { id: "loras", title: "LoRAs", category: "generation",
    tags: ["lora", "style", "character", "finetune", "download", "install", "weight", "civitai", "trigger"],
    content: "<p><strong>What are LoRAs?</strong> Small add-on files that teach an existing model new things \u2014 a specific art style, a character\u2019s face, a type of clothing. They\u2019re much smaller than full models (typically 10\u2013200 MB vs 2\u20137 GB) and you can stack multiple at once.</p><hr class=\"cx-divider\"><p><strong>Finding LoRAs:</strong> Browse <a href=\"https://civitai.com\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">CivitAI</a> and filter by \"LoRA\" type. Check the architecture matches your model (SD1.5 or SDXL). Read the description for <strong>trigger words</strong> \u2014 many LoRAs require a specific word in your prompt to activate.</p><hr class=\"cx-divider\"><p><strong>Installing:</strong> Download the <code>.safetensors</code> file, put it in <code>models/Lora/</code>. Available immediately, no restart needed.</p><hr class=\"cx-divider\"><p><strong>Using:</strong> Add <code>&lt;lora:filename:weight&gt;</code> to your prompt. Or click the <strong>LORA</strong> button near the prompt box to browse installed LoRAs and insert them by clicking.</p><hr class=\"cx-divider\"><p><strong>Weight guide:</strong> 0.3\u20130.5 = subtle influence. 0.6\u20130.8 = typical sweet spot. 0.9\u20131.0 = full strength (can artifact if overtrained). Above 1.0 = risky. When stacking multiple LoRAs, lower individual weights to prevent conflicts.</p><hr class=\"cx-divider\"><p><strong>Common problems:</strong> No effect = wrong architecture or missing trigger word. Burnt/oversaturated = weight too high. Same face every time = overtrained, lower to 0.3\u20130.5.</p>",
    deep: "<p>Standard A1111 syntax. Applied at generation time via Forge\u2019s LoRA loading system \u2014 modifies specific weight matrices in UNet and/or text encoder. The LoRA browser reads sidecar <code>.json</code> metadata files. Cards show trigger words, search matches against them, and clicking auto-inserts the tag and trigger words at the preferred weight.</p>",
  },

  { id: "wildcards", title: "Wildcards", category: "generation",
    tags: ["wildcard", "random", "dynamic", "lexicon", "template", "variety"],
    content: "<p>Wildcards insert randomized text into your prompts. Write <code>__wildcard_name__</code> and Studio replaces it with a random line from a matching text file. Every generation picks a different line, giving you automatic variety.</p><hr class=\"cx-divider\"><p><strong>Creating a wildcard file:</strong></p><p>1. Go to your wildcards folder: <code>extensions/sd-dynamic-prompts/wildcards/</code></p><p>2. Create a plain text file. The filename becomes the wildcard name (<code>colors.txt</code> \u2192 <code>__colors__</code>).</p><p>3. Put one option per line.</p><p>4. Use it in your prompt: <code>a __colors__ dress in a garden</code></p><hr class=\"cx-divider\"><p><strong>Folders:</strong> Organize wildcards into folders. A file at <code>wildcards/characters/hair.txt</code> is used as <code>__characters/hair__</code>.</p><hr class=\"cx-divider\"><p><strong>Management:</strong> The <strong>WILDCARD</strong> button near the prompt box opens the wildcard browser. The <strong>Wildcards</strong> tab in the main tab bar provides a full editor with folder tree, file creation, editing, and preview.</p>",
  },

  // ── INPAINTING ─────────────────────────────────────────────────

  { id: "inpaint_basics", title: "How to Edit Parts of Your Image", category: "inpainting",
    tags: ["inpaint", "mask", "edit", "fix", "fill", "soft", "workflow", "partial", "selective"],
    content: "<p>Inpainting lets you selectively change parts of an image while keeping the rest untouched. It\u2019s one of the most powerful and commonly used features in Studio.</p><hr class=\"cx-divider\"><p><strong>Step by step:</strong></p><p>1. Have an image on your canvas (generate one or load one).</p><p>2. Press <span class=\"cx-kbd\">Q</span> or click <em>Mask</em>. Your brush now paints a red overlay instead of color.</p><p>3. Paint red over the area you want to change.</p><p>4. Write a prompt describing what should appear in the masked area.</p><p>5. Hit Generate. Only the red area changes.</p><p>6. Press <span class=\"cx-kbd\">Q</span> again to exit mask mode.</p><hr class=\"cx-divider\"><p><strong>Whole Picture vs Only Masked:</strong></p><p><em>Whole Picture</em> generates the full canvas at your set resolution. The AI sees everything and the result blends naturally. <strong>Use for:</strong> removing objects, changing backgrounds, anything where context matters.</p><p><em>Only Masked</em> crops just the masked region, scales it up, generates, then composites back. Much more detail for small areas. <strong>Use for:</strong> fixing faces, refining details. Increase the <em>Padding</em> slider so the AI sees context around the mask.</p><hr class=\"cx-divider\"><p><strong>Fill mode \u2014 what goes under the mask:</strong></p><p>\u2022 <em>Original</em> \u2014 keeps existing pixels as the starting point. Best for most tasks.</p><p>\u2022 <em>Fill</em> \u2014 replaces with solid average color. Best for <strong>removing objects</strong> \u2014 the AI fills naturally instead of building on top.</p><p>\u2022 <em>Latent Noise / Latent Nothing</em> \u2014 more creative freedom, less predictable.</p><hr class=\"cx-divider\"><p><strong>Denoise guide:</strong></p><p>\u2022 0.3\u20130.5 \u2014 subtle refinement, artifact cleanup.</p><p>\u2022 0.5\u20130.7 \u2014 moderate reshaping.</p><p>\u2022 0.7\u20130.9 \u2014 major replacement.</p><p>\u2022 1.0 \u2014 complete replacement, nothing preserved.</p><hr class=\"cx-divider\"><p><strong>Blur:</strong> Softens the mask edge. Higher values (8\u201316) = smoother transitions. Use 0 for hard cuts.</p><hr class=\"cx-divider\"><p><strong>Common recipes:</strong></p><p>\u2022 <em>Fix a face:</em> Only Masked + Original + Padding 64\u2013128 + Denoise 0.4\u20130.6.</p><p>\u2022 <em>Remove an object:</em> Whole Picture + Fill + Denoise 0.7\u20130.9. Describe replacement.</p><p>\u2022 <em>Add something new:</em> Original + Denoise 0.7\u20130.9. Describe the addition.</p><p>\u2022 <em>Outpaint:</em> Resize canvas larger, mask empty area, Fill + Denoise 0.8\u20131.0.</p>",
    deep: "<p>Mask is a separate canvas buffer, not a layer. \"Only Masked\" with padding = A1111\u2019s \"Inpaint at full resolution\" \u2014 crops masked region plus padding, scales to gen resolution, generates, composites back with mask feathering.</p><p><strong>Soft Inpainting</strong> (toggle visible when mask mode active): modifies the pipeline for smooth boundary blending. Parameters: Schedule Bias, Preservation, Transition Contrast, Mask Influence, Difference Threshold, Difference Contrast. Best with feathered masks. Adds processing overhead.</p>",
  },

  // ── ADVANCED FEATURES ──────────────────────────────────────────

  { id: "regional_prompting", title: "Regional Prompting", category: "advanced",
    tags: ["regional", "regions", "spatial", "attention", "zone", "area", "multi", "couple"],
    content: "<p>Regional prompting lets you assign different descriptions to different areas of your canvas. Instead of one prompt for the whole image, you can say \"forest on the left, city on the right.\"</p><hr class=\"cx-divider\"><p><strong>Step by step:</strong></p><p>1. In the Generate tab, scroll to <em>Regions</em> and click <strong>+</strong> to add a region.</p><p>2. A new region appears with a color swatch and prompt field.</p><p>3. Switch to the brush (<span class=\"cx-kbd\">B</span>) and paint on the canvas. The region\u2019s color marks where it applies.</p><p>4. Type a prompt for this region \u2014 describe what should appear in the painted area.</p><p>5. Add more regions as needed. Each gets its own color and prompt.</p><p>6. Your <em>main prompt</em> still affects the whole image. Regions add local control on top.</p><p>7. Hit Generate.</p><hr class=\"cx-divider\"><p><strong>Tips:</strong></p><p>\u2022 Regions can overlap. Where they do, both prompts influence.</p><p>\u2022 Small regions work. Studio\u2019s system is specifically designed for this \u2014 small painted regions get their own content regardless of how much canvas area larger regions occupy.</p><p>\u2022 Use the main prompt for overall qualities (lighting, style) and regions for specific content.</p><p>\u2022 Don\u2019t forget to clear regions when done \u2014 they persist until removed.</p>",
    deep: "<p>Custom attention couple architecture with pre-softmax spatial bias. Unlike grid-based or output-blending approaches (Forge Couple, Regional Prompter, ComfyUI nodes), Studio injects a spatial bias matrix into the attention computation <em>before</em> softmax \u2014 steering where the model allocates content rather than fighting attention outputs after the fact. All region conditionings concatenated into one K tensor, Q @ K\u1d40 computed manually with spatial bias added before softmax. This is the first implementation of Bounded Attention concepts as a Forge/A1111 extension.</p><p>Includes self-attention masking via <code>attn1_replace</code>. Unpainted gaps between regions act as coherence bridges. Global prompt is prepended to each region encoding. <code>1-t\u00b2</code> decay curve holds spatial control through the detail phase.</p>",
  },

  { id: "hires_fix", title: "HiRes Fix", category: "advanced",
    tags: ["hires", "upscale", "upscaler", "detail", "resolution", "two-pass"],
    content: "<p>Two-pass generation: generates at normal size first, then upscales and adds detail. Produces much sharper results than generating at large resolution directly.</p><p><strong>Scale:</strong> enlargement factor (2.0 = double dimensions).</p><p><strong>Denoise:</strong> 0.2\u20130.4 for detail without changing content. Higher values reshape more.</p><p><strong>Steps:</strong> 0 = same as first pass.</p><p><strong>Upscaler:</strong> \"Latent\" = smooth/painterly feel. R-ESRGAN = sharp/detailed.</p>",
    deep: "<p>Base resolution \u2192 latent or pixel upscale \u2192 img2img at scaled resolution. Separate CFG and checkpoint overrides available for the second pass. Output dimensions = base \u00d7 scale; UI restores base dims after generation. HiRes + ADetailer = multiplicative cost \u2014 each adds a full pass.</p>",
  },

  { id: "adetailer", title: "ADetailer", category: "advanced",
    tags: ["adetailer", "face", "detail", "yolo", "hand", "detect", "auto"],
    content: "<p>Automatically detects faces (and optionally hands/bodies) in your generated image and regenerates them at higher detail. Fixes the most common AI problem \u2014 faces looking wrong or blurry at smaller sizes.</p><p>3 slots available. Slot 1 is pre-configured for face detection. Enable the checkbox and it runs automatically after generation.</p><p>Each slot has its own <em>prompt</em> (describe the face specifically), <em>confidence</em> (how sure the detector must be), and <em>denoise</em> (how much to change).</p>",
    deep: "<p>Post-generation YOLO-based detection + inpainting pipeline. Per-slot flow: detect \u2192 crop region \u2192 inpaint at higher resolution \u2192 composite back. Models: face_yolov8n, hand_yolov8n, etc. Runs after HiRes Fix if both enabled. Studio\u2019s fork stores character-only post-wildcard-resolution text in <code>ad_prompt</code> and uses an <code>is_hr_pass</code> discriminator to distinguish hires denoise from AD inner passes.</p>",
  },

  { id: "controlnet", title: "ControlNet", category: "advanced",
    tags: ["controlnet", "pose", "depth", "edge", "canny", "openpose", "reference", "structure"],
    content: "<p>ControlNet gives the AI structural guidance \u2014 \"follow this pose,\" \"use this edge map,\" \"keep this depth layout.\" It analyzes a source image and uses that structure to guide generation.</p><hr class=\"cx-divider\"><p><strong>Common use cases:</strong></p><p><em>Keep a pose:</em> Preprocessor \u2192 OpenPose, Model \u2192 OpenPose ControlNet. The AI follows the detected pose but creates new content.</p><p><em>Keep edges/lines:</em> Preprocessor \u2192 Canny, Model \u2192 Canny ControlNet. Maintains architectural layouts, mechanical designs, linework.</p><p><em>Keep depth layout:</em> Preprocessor \u2192 Depth, Model \u2192 Depth ControlNet. Foreground/background relationships stay the same.</p><hr class=\"cx-divider\"><p><strong>Key settings:</strong></p><p>\u2022 <strong>Weight</strong> (0.0\u20132.0): How strongly the structure guide affects the result. 1.0 = full.</p><p>\u2022 <strong>Source:</strong> Canvas (composite), Active Layer (just selected layer), or Upload (external image).</p><p>\u2022 <strong>Start/End:</strong> Which portion of denoising ControlNet is active. 0.0\u20130.5 gives structural guidance early without constraining fine details later.</p><p>Studio has 2 ControlNet units \u2014 combine them (e.g., pose + depth).</p><p><strong>Important:</strong> Preprocessor and model must match in type AND architecture (SD1.5 vs SDXL).</p>",
  },

  { id: "workshop_merging", title: "Model Merging (Workshop)", category: "advanced",
    tags: ["workshop", "merge", "blend", "weighted sum", "slerp", "ties", "dare"],
    content: "<p><strong>What is model merging?</strong> Combining two (or three) AI models into a new one that blends their abilities. If Model A is great at photorealism and Model B is great at anime, a merge can create a model that does both.</p><hr class=\"cx-divider\"><p><strong>Basic merge (Weighted Sum):</strong></p><p>1. Open the <em>Workshop</em> tab.</p><p>2. Select Model A (base) and Model B (blend source).</p><p>3. Set method to <strong>Weighted Sum</strong>.</p><p>4. Set Weight: 0.0 = 100% A, 1.0 = 100% B, 0.3 = mostly A with some B.</p><p>5. Click <strong>Test Merge</strong> to try in memory without saving. Generate test images.</p><p>6. Happy? Click <strong>Save to Disk</strong>.</p><hr class=\"cx-divider\"><p><strong>Other methods:</strong></p><p>\u2022 <strong>SLERP:</strong> Like Weighted Sum but preserves weight magnitudes. Usually sharper results.</p><p>\u2022 <strong>Add Difference:</strong> Transplants what B learned from C onto A. Good for transferring specific skills.</p><p>\u2022 <strong>TIES / DARE:</strong> Advanced methods that filter noise from finetunes. The Workshop describes each method when selected.</p>",
    deep: "<p>STAR at lambda 1.0 corrupts output; safe range is 0.3\u20130.5 with eta 0.1. SVD structure carries style identity; magnitude distributions are similar between clean models. CLIP embedding space has ~0.65\u20130.70 baseline cosine similarity between unrelated concepts.</p>",
  },

  // ── LAYERS & EXPORT ────────────────────────────────────────────

  { id: "layers_basics", title: "Working with Layers", category: "layers",
    tags: ["layers", "stack", "blend", "opacity", "reference", "paint"],
    content: "<p>Layers are transparent sheets stacked on each other. <strong>+</strong> adds a new layer, \u25b2\u25bc reorder, \u21e9 merge down, eye toggles visibility. Each layer has its own Opacity and Blend Mode.</p><p>Generated images land on the <strong>reference layer</strong> (bottom). Your painting goes on <strong>paint layers</strong> above. This means regenerating never destroys your painted edits \u2014 they live on a different layer.</p><p>Blend modes (Normal, Multiply, Screen, Overlay, Soft Light, Hard Light, Difference, etc.) control how layers interact. Merge Down composites using the current blend mode and opacity.</p>",
  },

  { id: "psd_export", title: "PSD Export", category: "layers",
    tags: ["psd", "export", "photoshop", "krita", "gimp"],
    content: "<p>Export your full layer stack as a PSD file that opens in Photoshop, Krita, GIMP, or any PSD-compatible editor. Click <em>Export</em> in the Layers section.</p><p>Layer names, blend modes, opacity, and visibility are all preserved. You can continue working in your preferred editor without losing your stack.</p>",
    deep: "<p>Built via ag-psd.js. Served via dedicated FastAPI route. Firefox uses POST + download (no <code>showSaveFilePicker</code> support).</p>",
  },

  // ── GALLERY ────────────────────────────────────────────────────

  { id: "gallery_overview", title: "Gallery", category: "gallery",
    tags: ["gallery", "browse", "search", "images", "output", "trackimage", "folder"],
    content: "<p>The Gallery module is a full image browser for your generated output. It watches your output folder in real-time \u2014 new images appear automatically as they\u2019re generated.</p><hr class=\"cx-divider\"><p><strong>Features:</strong></p><p>\u2022 <strong>Folder browsing</strong> with configurable scan directory.</p><p>\u2022 <strong>Search</strong> across filenames and metadata.</p><p>\u2022 <strong>Real-time updates</strong> \u2014 new images appear via filesystem watcher, no manual refresh needed.</p><p>\u2022 <strong>Send to Canvas</strong> \u2014 load any gallery image onto your canvas for editing.</p><p>\u2022 <strong>Metadata reading</strong> \u2014 view the prompt, settings, and seed used for any image with embedded metadata.</p><hr class=\"cx-divider\"><p>The watcher status dot in the topbar shows whether the filesystem watcher is active (green) or disconnected (gray).</p>",
    deep: "<p>Built on TrackImage by Moritz, integrated as Studio\u2019s Gallery module. Filesystem watcher via <code>watchdog</code> library. Real-time updates via SSE at <code>/studio/gallery/events</code>. <code>suppress_path()</code> prevents duplicate events on rename/move/delete. <code>restart_watcher()</code> fires on scan folder changes. SQLite backend with <code>PRAGMA busy_timeout=30000</code> for lock contention. <code>/suggest</code> autocomplete endpoint exists server-side.</p>",
  },

  // ── COMIC LAB ──────────────────────────────────────────────────

  { id: "comic_lab_overview", title: "Comic Lab", category: "comic_lab",
    tags: ["comic", "panel", "page", "layout", "bubble", "speech", "export"],
    content: "<p>Comic Lab is a full comic page editor built into Studio. It\u2019s not an image generator with comic formatting bolted on \u2014 it\u2019s a purpose-built layout system where AI generation is one tool among many.</p><p><strong>What it does:</strong> Panel layouts with custom arrangements or templates, AI generation directly into panels (each panel gets its own prompt), speech bubbles and SFX text with multiple styles and fonts, multi-page support with per-page undo, and export to PNG or PDF.</p><p><strong>When to use it vs Studio canvas:</strong> Use Comic Lab for multi-panel sequential art with text. Use Studio canvas for single-image creation and editing. They\u2019re complementary \u2014 you can generate and refine in Studio, then bring images into Comic Lab panels.</p><p>See the entries below for detailed guides on panels, bubbles, and export.</p>",
  },

  { id: "comic_panels", title: "Panel Layout & Editing", category: "comic_lab",
    tags: ["comic", "panel", "layout", "border", "template", "resize"],
    content: "<p>Panels are rectangular regions that hold images. Each panel has per-panel <strong>border width</strong>, <strong>border radius</strong>, and <strong>border color</strong> controls in the detail sidebar.</p><p>Templates provide common layouts (2-panel, 3-panel, grid, manga-style). A confirmation modal appears before applying a template if the canvas already has content.</p><p>Select panels to move, resize, or reorder them. Reordering changes the reading flow \u2014 toggle the <strong>Order</strong> button (or press <span class=\"cx-kbd\">R</span>) to see dashed lines with arrows showing the current reading order.</p>",
  },

  { id: "comic_bubbles", title: "Speech Bubbles & SFX", category: "comic_lab",
    tags: ["comic", "bubble", "speech", "text", "sfx", "font", "dialog"],
    content: "<p><strong>Speech bubbles:</strong> Click to add. Multiple styles available (rounded, thought cloud, shout). Edit text inline by double-clicking. Each bubble has its own font, size, and style.</p><p><strong>Font picker:</strong> sans-serif, serif, monospace, Comic Sans, Bangers, Permanent Marker, Creepster, Special Elite, Impact. Web fonts fall back gracefully if Google Fonts aren\u2019t loaded.</p><p><strong>SFX text:</strong> Bold text with thick stroke outline, no bubble shape. Defaults to Impact, 36px, yellow (#FFD600) with 4px black stroke. Great for \"BOOM!\", \"CRASH!\", \"ZAP!\" effects. Text stroke controls (width and color) are available on all bubble styles.</p><p><strong>Layer ordering:</strong> Four buttons (⤓↓↑⤒) reorder bubbles. Keyboard: <span class=\"cx-kbd\">]</span> forward, <span class=\"cx-kbd\">[</span> back, <span class=\"cx-kbd\">Shift+]</span> front, <span class=\"cx-kbd\">Shift+[</span> back.</p>",
  },

  { id: "comic_pages", title: "Multi-Page & Export", category: "comic_lab",
    tags: ["comic", "page", "multipage", "export", "pdf", "png"],
    content: "<p><strong>Multi-page:</strong> Each page is fully isolated \u2014 its own panels, bubbles, dimensions, background color, and undo stack. The page strip at the bottom shows numbered tabs. <strong>+</strong> adds a page after the current one. Right-click for duplicate/delete.</p><p><span class=\"cx-kbd\">Ctrl+PageUp/PageDown</span> navigates between pages.</p><hr class=\"cx-divider\"><p><strong>Export:</strong></p><p>\u2022 <strong>PNG</strong> (<span class=\"cx-kbd\">Ctrl+E</span>) \u2014 current page, full resolution. No selection highlights.</p><p>\u2022 <strong>PDF</strong> (<span class=\"cx-kbd\">Ctrl+Shift+E</span>) \u2014 all pages. Each page rendered to JPEG and embedded. Zero dependencies.</p><hr class=\"cx-divider\"><p><strong>Save/Load:</strong> <span class=\"cx-kbd\">Ctrl+S</span> saves as <code>.comic.json</code>. Drag and drop a <code>.comic.json</code> onto the canvas to load. V1 single-page files auto-upgrade on load.</p>",
  },

  // ── TROUBLESHOOTING ────────────────────────────────────────────

  { id: "common_problems", title: "Common Problems", category: "troubleshooting",
    tags: ["problem", "error", "black", "artifact", "broken", "fix", "slow", "load", "seed"],
    content: "<p><strong>Black image:</strong> Model didn\u2019t load or VRAM ran out. Check status bar \u2014 reload model from dropdown, reduce dimensions, or disable HiRes Fix.</p><p><strong>Garbled/noisy result:</strong> CFG too high or wrong model for your settings. Lower CFG to 5\u20137. SDXL models need at least 768\u00d7768.</p><p><strong>Generation is very slow:</strong> Steps + HiRes Fix + ADetailer are multiplicative. Each adds a full pass. Disable what you don\u2019t need.</p><p><strong>Model takes forever to load:</strong> The first time you load a model, Forge may need to download additional components (text encoders, VAE, safety checker files). This is a one-time download per model architecture. Subsequent loads are fast.</p><p><strong>Same image every time:</strong> Your seed is locked. Check the Seed field \u2014 if it\u2019s not -1, click the <strong>dice button</strong> to re-enable random seeds.</p><p><strong>Wrong colors / washed out:</strong> Try a different VAE in the dropdown.</p><p><strong>\"Disconnected\" in status bar:</strong> WebSocket dropped. Refresh the page. If persistent, check the Forge terminal for errors.</p><p><strong>Extra fingers / bad anatomy:</strong> Common AI artifact. Use ADetailer for faces. Add \"bad hands, extra fingers\" to negatives. Inpaint specific problem areas manually.</p><p><strong>LoRA has no effect:</strong> Architecture mismatch (SD1.5 LoRA on SDXL model), missing trigger word, or weight too low.</p><p><strong>ControlNet error on RTX 5000 series:</strong> Some preprocessors (especially Depth Anything) crash due to xformers not supporting CUDA capability 12.0. Use Canny or other preprocessors that don\u2019t rely on xformers.</p>",
  },

  { id: "vram_management", title: "VRAM Management", category: "troubleshooting",
    tags: ["vram", "memory", "gpu", "unload", "low"],
    content: "<p>VRAM is your GPU\u2019s memory. The loaded model is the biggest user (4\u20138 GB). Status bar shows current usage, color-coded: green (&lt;60%), amber (60\u201385%), red (&gt;85%).</p><p><strong>Running low?</strong> Reduce image dimensions (768 instead of 1024), keep Batch Size at 1, disable HiRes Fix and ControlNet when not in use.</p><p><strong>Unloading:</strong> Settings \u2192 VRAM \u2192 Unload Model frees all VRAM. Auto-unload does this after an idle timeout (configurable 5\u201330 minutes). The model reloads on next generation.</p>",
    deep: "<p>VRAM monitoring via <code>/studio/vram</code>. Manual unload via <code>/studio/unload_model</code>. Auto-unload fires via WebSocket after configurable idle timeout. SDXL ~6\u20137 GB, SD1.5 ~4 GB, ControlNet +1\u20132 GB per loaded unit, HiRes 2\u00d7 = 4\u00d7 latent tensor during second pass.</p>",
  },

  // ── SHORTCUTS ──────────────────────────────────────────────────

  { id: "shortcuts_tools", title: "Tool Shortcuts", category: "shortcuts",
    tags: ["shortcut", "keyboard", "hotkey", "tool"],
    content: "<p><span class=\"cx-kbd\">B</span> Brush \u2022 <span class=\"cx-kbd\">E</span> Eraser \u2022 <span class=\"cx-kbd\">I</span> Eyedropper \u2022 <span class=\"cx-kbd\">G</span> Fill/Gradient \u2022 <span class=\"cx-kbd\">U</span> Shape \u2022 <span class=\"cx-kbd\">T</span> Text</p><p><span class=\"cx-kbd\">S</span> Smudge \u2022 <span class=\"cx-kbd\">R</span> Blur \u2022 <span class=\"cx-kbd\">J</span> Dodge/Burn \u2022 <span class=\"cx-kbd\">K</span> Clone \u2022 <span class=\"cx-kbd\">Y</span> Liquify</p><p><span class=\"cx-kbd\">M</span> Rect select \u2022 <span class=\"cx-kbd\">O</span> Ellipse select \u2022 <span class=\"cx-kbd\">L</span> Lasso \u2022 <span class=\"cx-kbd\">W</span> Wand \u2022 <span class=\"cx-kbd\">C</span> Crop \u2022 <span class=\"cx-kbd\">V</span> Transform</p><p><span class=\"cx-kbd\">Q</span> Toggle mask mode \u2022 <span class=\"cx-kbd\">D</span> Reset colors \u2022 <span class=\"cx-kbd\">X</span> Swap FG/BG</p>",
  },

  { id: "shortcuts_canvas", title: "Canvas & Editing Shortcuts", category: "shortcuts",
    tags: ["shortcut", "keyboard", "undo", "zoom", "pan", "clipboard"],
    content: "<p><span class=\"cx-kbd\">Ctrl+Z</span> Undo \u2022 <span class=\"cx-kbd\">Ctrl+Shift+Z</span> Redo</p><p><span class=\"cx-kbd\">Ctrl+A</span> Select all \u2022 <span class=\"cx-kbd\">Ctrl+D</span> Deselect \u2022 <span class=\"cx-kbd\">Ctrl+Shift+I</span> Invert selection</p><p><span class=\"cx-kbd\">Ctrl+C/X/V</span> Copy/Cut/Paste \u2022 <span class=\"cx-kbd\">Delete</span> Clear selection</p><p><span class=\"cx-kbd\">Ctrl+Enter</span> Generate \u2022 <span class=\"cx-kbd\">\\</span> Toggle panel</p><p><span class=\"cx-kbd\">F</span> or <span class=\"cx-kbd\">0</span> Zoom to fit \u2022 <span class=\"cx-kbd\">Scroll</span> Zoom \u2022 <span class=\"cx-kbd\">Space+Drag</span> Pan</p><p><span class=\"cx-kbd\">[</span>/<span class=\"cx-kbd\">]</span> Brush size \u2022 <span class=\"cx-kbd\">{</span>/<span class=\"cx-kbd\">}</span> Brush hardness \u2022 <span class=\"cx-kbd\">Shift+Drag</span> Size + opacity adjust</p><p><span class=\"cx-kbd\">Ctrl+Click</span> Eyedropper from any tool \u2022 <span class=\"cx-kbd\">Alt+Click</span> Clone source</p><p><span class=\"cx-kbd\">Ctrl+Shift+N</span> New layer \u2022 <span class=\"cx-kbd\">Ctrl+J</span> Duplicate layer \u2022 <span class=\"cx-kbd\">Ctrl+E</span> Merge down \u2022 <span class=\"cx-kbd\">Ctrl+Shift+E</span> Flatten</p><p><span class=\"cx-kbd\">Enter</span> Commit transform \u2022 <span class=\"cx-kbd\">Escape</span> Cancel / deselect</p>",
  },

];


// ══════════════════════════════════════════════════════════════════
// ENGINE
// ══════════════════════════════════════════════════════════════════

var _selectedEntry = null, _els = {};

function _search(q) {
  if (!q.trim()) return ENTRIES;
  var t = q.toLowerCase().split(/\s+/);
  return ENTRIES.filter(function (e) {
    var s = (e.title + " " + e.tags.join(" ") + " " + e.category + " " + (e.shortcut || "")).toLowerCase();
    return t.every(function (w) { return s.indexOf(w) >= 0; });
  });
}

function _buildUI(c) {
  c.innerHTML = '<div class="cx-layout"><div class="cx-nav"><div class="cx-search-wrap"><input type="text" class="cx-search" id="cxSearch" placeholder="Search docs..." autocomplete="off"></div><div class="cx-tree" id="cxTree"></div></div><div class="cx-content" id="cxContent"></div></div>';
  _els.search = c.querySelector("#cxSearch");
  _els.tree = c.querySelector("#cxTree");
  _els.content = c.querySelector("#cxContent");
  _renderTree(ENTRIES);
  _els.search.addEventListener("input", function () {
    var q = _els.search.value;
    _renderTree(_search(q), q.trim().length > 0);
  });
  _renderWelcome();
}

function _renderTree(entries, forceOpen) {
  var html = "";
  var isSearch = forceOpen === true;
  CATEGORIES.forEach(function (cat) {
    var ce = entries.filter(function (e) { return e.category === cat.id; });
    if (!ce.length) return;
    var hasActive = _selectedEntry && ce.some(function (e) { return e.id === _selectedEntry.id; });
    var open = isSearch || hasActive;
    html += '<div class="cx-category' + (open ? ' open' : '') + '" data-cat="' + cat.id + '">';
    html += '<div class="cx-cat-title" data-cat-toggle="' + cat.id + '"><span class="cx-cat-arrow">\u25b6</span>' + cat.label + '</div>';
    html += '<div class="cx-cat-entries">';
    ce.forEach(function (e) {
      var a = (_selectedEntry && _selectedEntry.id === e.id) ? " active" : "";
      var sc = e.shortcut ? ' <span style="float:right;color:var(--text-4);font-family:var(--mono);font-size:9px;">' + e.shortcut + '</span>' : "";
      html += '<button class="cx-entry' + a + '" data-id="' + e.id + '">' + e.title + sc + '</button>';
    });
    html += '</div></div>';
  });
  if (!entries.length) html = '<div class="cx-no-results">No matching entries</div>';
  _els.tree.innerHTML = html;
  // Category toggle
  _els.tree.querySelectorAll(".cx-cat-title").forEach(function (t) {
    t.addEventListener("click", function () {
      var cat = t.closest(".cx-category");
      if (cat) cat.classList.toggle("open");
    });
  });
  // Entry click
  _els.tree.querySelectorAll(".cx-entry").forEach(function (b) {
    b.addEventListener("click", function () {
      var e = ENTRIES.find(function (x) { return x.id === b.dataset.id; });
      if (e) _selectEntry(e);
    });
  });
}

function _selectEntry(e) {
  _selectedEntry = e;
  // Auto-expand the selected entry's category, collapse others
  _els.tree.querySelectorAll(".cx-category").forEach(function (cat) {
    if (cat.dataset.cat === e.category) cat.classList.add("open");
  });
  _els.tree.querySelectorAll(".cx-entry").forEach(function (b) { b.classList.toggle("active", b.dataset.id === e.id); });
  var cat = CATEGORIES.find(function (c) { return c.id === e.category; });
  var content = e.content || "";
  var sc = e.shortcut ? '<p style="margin-bottom:12px;"><span class="cx-kbd">' + e.shortcut + '</span></p>' : "";

  var deepHtml = "";
  if (e.deep) {
    deepHtml = '<div class="cx-deep"><button class="cx-deep-toggle" onclick="this.parentElement.classList.toggle(\'open\')">Under the Hood <span class="cx-deep-arrow">\u25b6</span></button><div class="cx-deep-body">' + e.deep + '</div></div>';
  }

  var showMeHtml = "";
  if (window.StudioShowMe && StudioShowMe.has(e.id)) {
    var variants = StudioShowMe.forEntry(e.id);
    showMeHtml = '<div class="cx-showme">';
    variants.forEach(function (v) {
      showMeHtml += '<button class="cx-showme-btn" data-showme="' + v.id + '">' + v.label + '</button>';
    });
    showMeHtml += '</div>';
  }

  _els.content.innerHTML = '<div class="cx-article"><div class="cx-article-category">' + (cat ? cat.label : "") + '</div><div class="cx-article-title">' + e.title + '</div>' + sc + showMeHtml + '<div class="cx-article-body">' + content + '</div>' + deepHtml + '</div>';

  // Wire Show Me buttons
  _els.content.querySelectorAll("[data-showme]").forEach(function (btn) {
    btn.addEventListener("click", function () { StudioShowMe.run(btn.dataset.showme); });
  });
}

function _renderWelcome() {
  var sc = [
    { id: "core_workflow",       label: "The Core Workflow",       desc: "Start here" },
    { id: "canvas_routing",      label: "Canvas Routing",          desc: "How Studio decides what to do" },
    { id: "models_and_vae",      label: "Models & VAE",            desc: "Getting started" },
    { id: "inpaint_basics",      label: "Editing Parts of Images", desc: "Inpainting guide" },
    { id: "loras",               label: "LoRAs",                   desc: "Style & character add-ons" },
    { id: "regional_prompting",  label: "Regional Prompting",      desc: "Multi-zone control" },
    { id: "common_problems",     label: "Common Problems",         desc: "Troubleshooting" },
    { id: "shortcuts_tools",     label: "Keyboard Shortcuts",      desc: "Hotkeys" },
  ];
  var h = '<div class="cx-welcome"><div class="cx-welcome-title">Codex</div><div class="cx-welcome-text">Reference documentation for every tool, parameter, and feature in Forge Studio.</div><div class="cx-welcome-shortcuts">';
  sc.forEach(function (s) {
    h += '<div class="cx-welcome-shortcut" data-id="' + s.id + '"><span class="cx-welcome-shortcut-title">' + s.label + '</span><span class="cx-welcome-shortcut-desc">' + s.desc + '</span></div>';
  });
  h += '</div></div>';
  _els.content.innerHTML = h;
  _els.content.querySelectorAll(".cx-welcome-shortcut").forEach(function (el) {
    el.addEventListener("click", function () {
      var e = ENTRIES.find(function (x) { return x.id === el.dataset.id; });
      if (e) _selectEntry(e);
    });
  });
}

// ══════════════════════════════════════════════════════════════════
// POPOVER — floating help panel in Studio tab
// ══════════════════════════════════════════════════════════════════

var _popover = null, _popEls = {}, _popVisible = false;

function _buildPopover() {
  var studio = document.getElementById("app-studio");
  if (!studio || document.getElementById("cxPopover")) return;

  // Ensure CSS is loaded (popover may render before Codex tab is ever opened)
  if (!document.querySelector('link[href*="codex.css"]')) {
    var l = document.createElement("link"); l.rel = "stylesheet";
    l.href = "/studio/static/codex.css?v=" + VERSION; document.head.appendChild(l);
  }

  // Toggle button — inject into toolstrip before the spacer
  var toolstrip = document.getElementById("toolstrip");
  if (toolstrip) {
    var spacer = toolstrip.querySelector(".tool-spacer");
    var btn = document.createElement("button");
    btn.className = "tool-btn cx-pop-toggle";
    btn.id = "cxPopToggle";
    btn.title = "Quick Reference (?)";
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    btn.addEventListener("click", _togglePopover);
    // Pulse on first visit to draw attention
    if (!localStorage.getItem("cx-pop-seen")) {
      btn.classList.add("first-visit");
      btn.addEventListener("click", function () {
        btn.classList.remove("first-visit");
        localStorage.setItem("cx-pop-seen", "1");
      }, { once: true });
    }
    // Add separator then button before the spacer
    var sep = document.createElement("div");
    sep.className = "tool-sep";
    if (spacer) { toolstrip.insertBefore(sep, spacer); toolstrip.insertBefore(btn, spacer); }
    else { toolstrip.appendChild(sep); toolstrip.appendChild(btn); }
  }

  // Popover panel
  var pop = document.createElement("div");
  pop.className = "cx-popover";
  pop.id = "cxPopover";
  pop.innerHTML = '<div class="cx-pop-header">' +
    '<input type="text" class="cx-pop-search" id="cxPopSearch" placeholder="Search docs..." autocomplete="off">' +
    '<button class="cx-pop-close" id="cxPopClose" title="Close">\u2715</button>' +
    '</div>' +
    '<div class="cx-pop-results" id="cxPopResults"></div>' +
    '<div class="cx-pop-article" id="cxPopArticle"></div>';
  studio.appendChild(pop);

  _popover = pop;
  _popEls.search = pop.querySelector("#cxPopSearch");
  _popEls.results = pop.querySelector("#cxPopResults");
  _popEls.article = pop.querySelector("#cxPopArticle");

  // Events
  _popEls.search.addEventListener("input", function () {
    var q = _popEls.search.value;
    if (q.trim().length > 0) {
      _popRenderResults(_search(q));
      _popEls.results.style.display = "block";
      _popEls.article.style.display = "none";
    } else {
      _popEls.results.style.display = "none";
      if (!_popEls.article.innerHTML) _popRenderHome();
    }
  });

  pop.querySelector("#cxPopClose").addEventListener("click", _hidePopover);

  // Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _popVisible) { _hidePopover(); e.stopPropagation(); }
  });

  // Render home state
  _popRenderHome();
  console.log(TAG, "Popover built");
}

function _togglePopover() {
  if (_popVisible) _hidePopover();
  else _showPopover();
}

function _showPopover() {
  if (!_popover) return;
  _popover.classList.add("open");
  _popVisible = true;
  var btn = document.getElementById("cxPopToggle");
  if (btn) btn.classList.add("active");
  setTimeout(function () { if (_popEls.search) _popEls.search.focus(); }, 150);
}

function _hidePopover() {
  if (!_popover) return;
  _popover.classList.remove("open");
  _popVisible = false;
  var btn = document.getElementById("cxPopToggle");
  if (btn) btn.classList.remove("active");
}

function _popRenderHome() {
  var cats = [];
  CATEGORIES.forEach(function (cat) {
    var count = ENTRIES.filter(function (e) { return e.category === cat.id; }).length;
    if (count) cats.push('<button class="cx-pop-cat" data-cat="' + cat.id + '">' + cat.label + ' <span class="cx-pop-cat-count">' + count + '</span></button>');
  });
  _popEls.article.innerHTML = '<div class="cx-pop-home"><div class="cx-pop-home-title">Quick Reference</div><div class="cx-pop-home-text">Search above or browse by category.</div><div class="cx-pop-cats">' + cats.join("") + '</div></div>';
  _popEls.article.style.display = "block";
  _popEls.results.style.display = "none";

  _popEls.article.querySelectorAll(".cx-pop-cat").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var ce = ENTRIES.filter(function (e) { return e.category === btn.dataset.cat; });
      _popRenderResults(ce);
      _popEls.results.style.display = "block";
      _popEls.article.style.display = "none";
    });
  });
}

function _popRenderResults(entries) {
  if (!entries.length) {
    _popEls.results.innerHTML = '<div class="cx-pop-empty">No matching entries</div>';
    return;
  }
  var html = "";
  entries.forEach(function (e) {
    var cat = CATEGORIES.find(function (c) { return c.id === e.category; });
    html += '<button class="cx-pop-result" data-id="' + e.id + '"><span class="cx-pop-result-title">' + e.title + '</span><span class="cx-pop-result-cat">' + (cat ? cat.label : "") + '</span></button>';
  });
  _popEls.results.innerHTML = html;
  _popEls.results.querySelectorAll(".cx-pop-result").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var e = ENTRIES.find(function (x) { return x.id === btn.dataset.id; });
      if (e) _popSelectEntry(e);
    });
  });
}

function _popSelectEntry(e) {
  var cat = CATEGORIES.find(function (c) { return c.id === e.category; });
  var sc = e.shortcut ? '<p style="margin-bottom:8px;"><span class="cx-kbd">' + e.shortcut + '</span></p>' : "";
  var deepHtml = "";
  if (e.deep) {
    deepHtml = '<div class="cx-deep"><button class="cx-deep-toggle" onclick="this.parentElement.classList.toggle(\'open\')">Under the Hood <span class="cx-deep-arrow">\u25b6</span></button><div class="cx-deep-body">' + e.deep + '</div></div>';
  }
  var showMeHtml = "";
  if (window.StudioShowMe && StudioShowMe.has(e.id)) {
    var variants = StudioShowMe.forEntry(e.id);
    showMeHtml = '<div class="cx-showme">';
    variants.forEach(function (v) {
      showMeHtml += '<button class="cx-showme-btn" data-showme="' + v.id + '">' + v.label + '</button>';
    });
    showMeHtml += '</div>';
  }
  _popEls.article.innerHTML = '<div class="cx-pop-back-wrap"><button class="cx-pop-back">\u2190 Back</button></div>' +
    '<div class="cx-article"><div class="cx-article-category">' + (cat ? cat.label : "") + '</div><div class="cx-article-title">' + e.title + '</div>' + sc + showMeHtml + '<div class="cx-article-body">' + e.content + '</div>' + deepHtml + '</div>';
  _popEls.results.style.display = "none";
  _popEls.article.style.display = "block";
  _popEls.article.scrollTop = 0;

  // Wire Show Me buttons
  _popEls.article.querySelectorAll("[data-showme]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _hidePopover();
      StudioShowMe.run(btn.dataset.showme);
    });
  });

  _popEls.article.querySelector(".cx-pop-back").addEventListener("click", function () {
    var q = _popEls.search.value;
    if (q.trim().length > 0) {
      _popRenderResults(_search(q));
      _popEls.results.style.display = "block";
      _popEls.article.style.display = "none";
    } else {
      _popRenderHome();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// MODULE REGISTRATION
// ══════════════════════════════════════════════════════════════════

if (window.StudioModules) {
  StudioModules.register("codex", {
    label: "Codex", icon: "\u229e",
    init: function (container) {
      console.log(TAG, "Initializing Codex v" + VERSION);
      if (!document.querySelector('link[href*="codex.css"]')) {
        var l = document.createElement("link"); l.rel = "stylesheet";
        l.href = "/studio/static/codex.css?v=" + VERSION; document.head.appendChild(l);
      }
      _buildUI(container);
    },
    activate: function () {
      setTimeout(function () { if (_els.search) _els.search.focus(); }, 100);
    },
    deactivate: function () {},
  });
} else console.warn(TAG, "StudioModules not available");

// Build popover on load — needs to be in Studio tab before Codex tab is ever opened
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () { setTimeout(_buildPopover, 100); });
} else {
  setTimeout(_buildPopover, 100);
}

})();
