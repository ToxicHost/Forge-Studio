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
 *
 * Additional credits:
 *   VRAM Unload feature suggested by SnekySnek
 *   Save Last Session feature suggested by Railer
 */
(function () {
"use strict";
var TAG = "[Codex]", VERSION = "2.1.5";

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
  { id: "video_lab",        label: "Video Lab" },
  { id: "workshop",         label: "Workshop" },
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

  { id: "tutorials_and_tours", title: "Interactive Tutorials & Tours", category: "getting_started",
    tags: ["tutorial", "show me", "tour", "walkthrough", "learn", "first run", "beginner", "experienced", "restart", "education"],
    content: "<p>Studio has interactive tutorials that walk you through features hands-on, in the actual UI, on a real canvas. Three places to find them.</p><hr class=\"cx-divider\"><p><strong>1. Show Me buttons in Codex.</strong> Many entries in this Codex have a blue <strong>Show Me</strong> button at the top. Click it and Studio opens a new tutorial document, sets the scene up for you, and walks you through the feature step-by-step. Currently available for: Inpainting, Regional Prompting, ControlNet, Layers, LoRA Browser, Brush Dynamics, Wildcards, Symmetry Painting, and the Core Workflow.</p><hr class=\"cx-divider\"><p><strong>2. The first-run path picker.</strong> The first time you launched Studio, you saw a card with two options:</p><p>\u2022 <em>I\u2019m new to AI image generation</em> \u2014 progressive walkthrough that makes your first image, then reveals controls in groups as you go. Branches to a model-acquisition flow if Studio detects you don\u2019t have any models installed yet, and to an inpaint flow if you click <em>Result \u2192 Canvas</em>. Persists \u2014 if you close mid-walkthrough, it resumes where you left off.</p><p>\u2022 <em>I\u2019ve used Stable Diffusion, Photoshop, or similar tools</em> \u2014 spatial orientation tour. Full UI visible from the start, focuses on what\u2019s different about Studio compared to other AI/art tools.</p><p>You can also skip and figure things out yourself.</p><hr class=\"cx-divider\"><p><strong>3. Restart from Settings.</strong> Open the <em>Settings</em> tab in the right panel and find the <em>Education</em> section. Two buttons:</p><p>\u2022 <em>Restart Tour</em> \u2014 replays your current path from the beginning.</p><p>\u2022 <em>Change Path</em> \u2014 brings the first-run picker back so you can switch between Beginner and Experienced.</p><hr class=\"cx-divider\"><p>None of these block you. You can dismiss any tour with <span class=\"cx-kbd\">Escape</span>, and Show Me tutorials happen on a separate document so they never disturb your real work.</p>",
  },

  { id: "first_image", title: "Making Your First Image", category: "getting_started",
    tags: ["first", "prompt", "generate", "beginner"],
    content: "<p>1. Type a description in the <strong>prompt box</strong> \u2014 \"a cat on a mountain at sunset\" works fine.</p><p>2. Click <em>Generate</em> (or <span class=\"cx-kbd\">Ctrl+Enter</span>).</p><p>3. Wait a few seconds. Your image appears in the output gallery.</p><p>4. Click <em>Result \u2192 Canvas</em> to place it on the canvas for editing.</p><p>Every image is unique \u2014 same prompt, different seed, different result. Try generating a few times to see the variety.</p>",
  },

  { id: "ui_layout", title: "UI Layout", category: "getting_started",
    tags: ["layout", "interface", "panels", "toolbar", "orientation"],
    content: "<p><strong>Left:</strong> Toolstrip \u2014 your painting tools (brush, eraser, fill, and 16 more).</p><p><strong>Center:</strong> Canvas \u2014 scroll to zoom, Space+drag to pan. This is where your image lives.</p><p><strong>Right:</strong> Panel \u2014 three tabs: Generate (prompt, settings, output), Extensions (ControlNet, ADetailer), and Settings. <span class=\"cx-kbd\">\\</span> collapses it for more canvas space.</p><p><strong>Top:</strong> Context bar \u2014 shows controls for whichever tool is active (size, opacity, hardness, etc.).</p><p><strong>Bottom:</strong> Status bar \u2014 generation progress, VRAM usage, canvas dimensions.</p><p><strong>Tab bar:</strong> Switch between Studio (canvas), Gallery, Video Lab, Workshop, Comic Lab, Wildcards, and Codex (you\u2019re here).</p>",
  },

  { id: "models_and_vae", title: "Models & VAE", category: "getting_started",
    tags: ["model", "checkpoint", "vae", "sdxl", "sd15", "load", "download", "install", "illustrious", "flux", "gguf", "fp8", "fp16", "architecture"],
    content: "<p>The <strong>model</strong> (also called a checkpoint) is the AI brain that generates your images. Without one, Studio can\u2019t generate anything. Different models produce completely different styles \u2014 photorealistic, anime, painterly, abstract.</p><hr class=\"cx-divider\"><p><strong>Getting your first model:</strong></p><p>1. Download a model file. Here\u2019s a good one to start with: <a href=\"https://pixeldrain.com/u/5pv797g8\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">ToxicHost\u2019s recommended starter model</a></p><p>2. Put the downloaded file in your Forge folder: <code>models/Stable-diffusion/</code></p><p>3. In Studio, click the refresh button (\u21bb) next to the Model dropdown. Your model appears \u2014 no restart needed.</p><p>4. Select it from the dropdown. <strong>Make sure the architecture selector</strong> (radio buttons: SD 1.5 / XL / Flux) matches your model \u2014 wrong architecture = errors.</p><p>Find more models on <a href=\"https://civitai.com\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">CivitAI</a> (checkpoints, LoRAs, community content) and <a href=\"https://huggingface.co\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--accent-bright);\">Hugging Face</a> (official releases).</p><hr class=\"cx-divider\"><p><strong>Architectures:</strong></p><p>\u2022 <strong>SD 1.5</strong> \u2014 smaller, faster, huge ecosystem. ~4 GB VRAM.</p><p>\u2022 <strong>SDXL / Illustrious</strong> \u2014 higher quality, more VRAM (6\u20137 GB). Illustrious models excel at anime and illustration styles.</p><p>\u2022 <strong>Flux</strong> \u2014 newer architecture with different prompt handling. Needs separate text encoders.</p><p>SD1.5, SDXL, and Flux checkpoints, LoRAs, and ControlNet models are <strong>not cross-compatible</strong>.</p><hr class=\"cx-divider\"><p><strong>Model formats:</strong></p><p>\u2022 <code>.safetensors</code> \u2014 standard, always prefer this.</p><p>\u2022 <code>.gguf</code> \u2014 quantized, uses less VRAM at some quality cost. Good for larger models on smaller GPUs.</p><p>\u2022 <strong>fp16 / fp8</strong> \u2014 numerical precision. Lower = less VRAM, slightly less quality. fp16 is the sweet spot for most. Set \"Diffusion in Low Bits\" to \"Automatic\" for fp8/GGUF models.</p><hr class=\"cx-divider\"><p><strong>VAE:</strong> The VAE handles color processing. Leave it on \"Automatic\" \u2014 most models include their own. If your colors look washed out or oversaturated, try switching to a specific VAE from the dropdown.</p>",
    deep: "<p>Model dropdown pulls from Forge\u2019s checkpoint directory. Hot-reload via refresh button \u2014 no restart. VAE \"Automatic\" uses baked-in or Forge global. For SD1.5 color issues try <code>vae-ft-mse-840000</code>. SDXL uses dual text encoders (CLIP-L + CLIP-G). Flux may require separate text encoder downloads. Some models need keywords in their path to be recognized (e.g. Flux-Kontext needs \"kontext\" in the filename).</p>",
  },

  { id: "output_workflow", title: "Saving & Using Results", category: "getting_started",
    tags: ["output", "save", "result", "canvas", "gallery", "format", "defaults", "persist", "server", "metadata", "filename", "fingerprint", "hash"],
    content: "<p>Generated images appear in the <strong>output gallery</strong> strip at the bottom of the Generate panel.</p><p><em>Result \u2192 Canvas</em> places the image on your canvas as a new layer \u2014 it doesn\u2019t overwrite your existing work. Pipeline results (generation, upscale) go to a reusable \"Gen Result\" layer.</p><p><em>Save</em> writes to disk (auto-save is on by default). You can change the format in Settings: PNG, JPEG, or WebP. <em>Embed metadata</em> stores your prompt and settings inside saved files so other tools (PNG Info, other AI UIs) can read them later.</p><hr class=\"cx-divider\"><p><strong>Gallery always remembers:</strong> Studio\u2019s Gallery tracks generation params for every image regardless of the <em>Embed metadata</em> setting. It uses a pixel fingerprint, so metadata survives file renames, moves between folders, and format conversions (PNG \u2192 JPG \u2192 WebP). Turning off <em>Embed metadata</em> only affects whether other tools can read it from the file itself.</p><hr class=\"cx-divider\"><p><strong>Filename convention:</strong> Auto-saved files use <code>Studio-NNNNN-<em>seed</em>.<em>ext</em></code>, where <em>NNNNN</em> is a 5-digit counter per output folder and <em>seed</em> is the exact seed used for that image. Batched images get sequential counters and sequential seeds.</p><hr class=\"cx-divider\"><p><strong>Workflow defaults:</strong> Save your current parameter settings (sampler, scheduler, CFG, steps, denoise, and more) as defaults via Settings \u2192 Defaults \u2192 <em>Save Current as Defaults</em>. These persist <strong>server-side</strong> and load automatically on next launch. Separate from per-tool brush settings, which are client-side.</p>",
    deep: "<p>Gallery metadata is keyed by SHA256 of the decoded RGB pixel data, computed locally in <code>compute_content_hash()</code>. Generation writes the metadata row to the Gallery DB immediately via <code>save_metadata_by_hash()</code>, without waiting for a Gallery scan. When the scan later finds the file on disk, it links the existing hash-keyed metadata row to the filepath-keyed image row. Because the key is the pixel fingerprint, not the path, operations that preserve pixel identity (rename, move, lossless format conversion) keep the metadata attached. Lossy re-encoding will break the link \u2014 the new file has different pixels, so it gets a new hash.</p><p>Filename counter is determined per-folder at save time by scanning for existing <code>Studio-NNNNN-*</code> files and incrementing the highest match, so manual deletions in a folder don\u2019t create gaps that get filled later.</p>",
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

  { id: "documents", title: "Documents & Tabs", category: "how_studio_works",
    tags: ["document", "documents", "tab", "tabs", "multi", "multiple", "workspace", "file", "switch", "new", "close", "rename"],
    content: "<p>Studio is a multi-document editor. The thin tab strip across the top of the canvas area lets you keep several separate workspaces open at once, like tabs in a browser or Photoshop.</p><hr class=\"cx-divider\"><p><strong>Each document is fully independent.</strong> When you switch tabs, Studio swaps the <em>entire</em> workspace:</p><p>\u2022 Layers, mask, selection, and regional prompt boxes</p><p>\u2022 Undo/redo stack</p><p>\u2022 Zoom level and pan position</p><p>\u2022 The entire Generate panel \u2014 prompt, negative, seed, sampler, CFG, steps, denoise, dimensions, batch, HiRes Fix settings, all 3 ADetailer slots, Soft Inpainting, inpaint area/fill/blur/padding</p><p>So Doc 1 can be a portrait you\u2019re refining at 768\u00d71024 with one prompt and seed, while Doc 2 is a landscape experiment at 1216\u00d7832 with a completely different prompt. Switching between them is instant \u2014 nothing bleeds across.</p><hr class=\"cx-divider\"><p><strong>Working with tabs:</strong></p><p>\u2022 <strong>+</strong> button at the end of the strip \u2014 creates a new blank document.</p><p>\u2022 <strong>Click</strong> a tab to switch to it.</p><p>\u2022 <strong>\u00d7</strong> on hover \u2014 closes that document. You can\u2019t close the last one. Closing a document with unsaved canvas changes prompts for confirmation.</p><p>\u2022 <strong>Double-click</strong> a tab name to rename inline. Enter to commit, Escape to cancel.</p><p>\u2022 <span class=\"cx-kbd\">Ctrl+]</span> and <span class=\"cx-kbd\">Ctrl+[</span> cycle forward and backward through documents.</p><p>\u2022 A small dot (\u2022) appears next to a tab\u2019s name when it has unsaved changes since the last snapshot.</p><hr class=\"cx-divider\"><p><strong>Show Me tutorials use this system.</strong> When you click a Show Me button in Codex, Studio opens the tutorial in a new document so your real work stays untouched. When the tutorial ends, the tutorial document is cleaned up automatically.</p>",
    deep: "<p>Implemented in <code>studio-docs.js</code>. Each document holds a full snapshot: <code>layers[]</code>, <code>activeLayerIdx</code>, <code>mask</code>, <code>regions</code>, <code>undoStack</code>/<code>redoStack</code>, <code>zoom</code>, <code>panX</code>/<code>panY</code>, <code>W</code>/<code>H</code>, plus the Generate panel state (values, selects, textareas, checkboxes \u2014 see <code>_GEN_VALUES</code>/<code>_GEN_SELECTS</code>/<code>_GEN_TEXTAREAS</code>/<code>_GEN_CHECKS</code> in the source). <code>_saveDoc()</code> snapshots to the current index; <code>_loadDoc()</code> restores a target. Switching always saves the outgoing doc first so no work is lost. Follows Comic Lab\u2019s multi-page pattern \u2014 the live canvas state is a window into the active document, not a separate store.</p>",
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

  { id: "extension_bridge", title: "Extension Bridge", category: "how_studio_works",
    tags: ["extension", "bridge", "blueprint", "third-party", "script", "alwayson"],
    content: "<p>Studio doesn\u2019t ignore Forge\u2019s extension ecosystem \u2014 it wraps it. When you install a compatible Forge extension (anything that registers as an <code>AlwaysOn</code> script), Studio auto-detects it and surfaces its controls in the <em>Extensions</em> panel alongside ControlNet and ADetailer.</p><hr class=\"cx-divider\"><p><strong>How it works:</strong> On startup Studio scans Forge\u2019s script runner for extensions, reads their control definitions, and builds UI for each one. Checkboxes, sliders, dropdowns, and dependent visibility all work automatically. No per-extension code required.</p><p>You can toggle any bridged extension on or off in <em>Settings</em>. Disabled extensions never run even if the original Forge UI would have had them active.</p><hr class=\"cx-divider\"><p><strong>What Studio handles natively instead:</strong> ControlNet, ADetailer, Soft Inpainting, Dynamic Prompts (wildcards), and AR Selector are replaced with Studio\u2019s own native UI rather than bridged \u2014 they\u2019re more deeply integrated.</p>",
    deep: "<p>Two-tier discovery: <strong>Blueprint Bridge</strong> reads an optional <code>blueprint.json</code> next to an extension\u2019s script (or bundled under <code>blueprints/</code>) for an explicit layout override and optional hooks module. <strong>AutoBridge</strong> falls back to reflective layout analysis \u2014 walks the Gradio component tree, detects <code>Column</code>/<code>Group</code> containers as group IDs, and probes <code>.change</code> callbacks to infer visibility dependencies and value propagation. The <code>/studio/extensions</code> manifest endpoint returns <code>controls</code>, <code>groups</code>, <code>layout</code>, <code>dependencies</code>, and any blueprint metadata. Tier 1 native modules are hardcoded into a <code>NATIVE_TITLES</code> exclusion set.</p>",
  },

  { id: "wildcards_editor", title: "The Wildcards Tab", category: "how_studio_works",
    tags: ["wildcards", "editor", "tab", "file", "folder", "tree", "search", "preview", "import", "export", "zip", "auto-save"],
    content: "<p>The <em>Wildcards</em> tab in the main tab bar is a full editor for your wildcard files. The <em>Wildcards</em> entry under Generation covers what wildcards are and the <code>__name__</code> syntax \u2014 this entry is about the editor itself.</p><hr class=\"cx-divider\"><p><strong>Layout:</strong> File tree on the left, editor on the right. Click any file in the tree to open it. The dot next to the filename turns amber when there are unsaved changes.</p><hr class=\"cx-divider\"><p><strong>Creating files and folders:</strong> Use <strong>+ File</strong> and <strong>+ Folder</strong> at the top of the tree. New files open immediately for editing. Folders nest \u2014 a file at <code>characters/hair.txt</code> is referenced as <code>__characters/hair__</code> in your prompts.</p><hr class=\"cx-divider\"><p><strong>Right-click a file or folder</strong> for rename, duplicate, move, and delete. You can also drag files between folders directly in the tree.</p><hr class=\"cx-divider\"><p><strong>Search modes:</strong> The search box has two modes, toggled with the <strong>Aa</strong> button next to it.</p><p>\u2022 <em>Filename</em> mode (default) \u2014 filters the tree to files matching the query.</p><p>\u2022 <em>Content</em> mode \u2014 searches inside files. Useful when you remember a phrase you wrote but not which file it\u2019s in.</p><hr class=\"cx-divider\"><p><strong>Live preview:</strong> Open the preview pane to see resolved sample lines from your wildcard file \u2014 including nested wildcards if your file references other wildcards. Refreshes as you edit.</p><hr class=\"cx-divider\"><p><strong>Auto-save:</strong> Toggle on to save changes ~1.5 seconds after you stop typing. Off by default \u2014 use <span class=\"cx-kbd\">Ctrl+S</span> manually if you prefer.</p><hr class=\"cx-divider\"><p><strong>Import / Export:</strong> Export your full wildcards collection as a <code>.zip</code> for backup or sharing. Import drops a <code>.zip</code> back into your wildcards folder \u2014 existing files with the same name are skipped, not overwritten.</p>",
  },

  { id: "session_vs_defaults", title: "Session Memory vs Workflow Defaults", category: "how_studio_works",
    tags: ["session", "defaults", "remember", "save", "settings", "persist", "categories", "workflow", "railer"],
    content: "<p>Studio has two separate ways to make your settings persist between launches. They overlap in confusing ways, so here\u2019s the difference.</p><hr class=\"cx-divider\"><p><strong>Workflow Defaults</strong> \u2014 a saved baseline you set deliberately. Settings \u2192 Defaults \u2192 <em>Save Current as Defaults</em> snapshots your current parameters (sampler, CFG, steps, dimensions, AD slots, etc.) and saves them <strong>server-side</strong>. Every launch starts from this baseline. Use <em>Reset</em> to clear them and go back to factory settings.</p><p>Think of this as: \"this is how I want Studio to start every time.\"</p><hr class=\"cx-divider\"><p><strong>Remember Last Session</strong> \u2014 picks up where you left off. Toggle on in Settings \u2192 Generation. Your prompts and settings save automatically when you close the page and restore on the next launch. Stored <strong>in your browser</strong>, not on the server.</p><p>Think of this as: \"don\u2019t make me retype my prompt every time I refresh.\"</p><hr class=\"cx-divider\"><p><strong>Picking which categories Session Memory saves:</strong> When the toggle is on, an accordion appears with checkboxes for each category. Uncheck what you don\u2019t want carried over.</p><p>\u2022 <em>Prompts</em> \u2014 positive and negative prompt text.</p><p>\u2022 <em>Generation params &amp; AR pools</em> \u2014 sampler, scheduler, CFG, steps, dimensions, batch settings, AR randomization pools.</p><p>\u2022 <em>Hires Fix</em> \u2014 enabled state, upscaler, scale, denoise, etc.</p><p>\u2022 <em>ADetailer</em> \u2014 all 3 slots\u2019 enable state, model, prompts, confidence, denoise.</p><p>\u2022 <em>Upscale</em> \u2014 upscaler model, scale, post-AD toggle.</p><p>\u2022 <em>Canvas settings</em> \u2014 grid, pen pressure, save outputs, live preview, metadata, panel collapse states.</p><p>\u2022 <em>Brush settings</em> \u2014 brush size.</p><p>\u2022 <em>Output format</em> \u2014 PNG/JPEG/WebP and quality.</p><p>\u2022 <em>Inpaint settings</em> \u2014 area mode, fill, mask blur, padding.</p><hr class=\"cx-divider\"><p><strong>Which order they apply:</strong> If both are active on launch, Session Memory wins \u2014 it loads last, on top of Defaults. Categories you unchecked in Session fall back to whatever Defaults have.</p><hr class=\"cx-divider\"><p><strong>Quick guide:</strong></p><p>\u2022 Want to always start with the same baseline? <strong>Defaults</strong>.</p><p>\u2022 Want continuity between sessions? <strong>Session Memory</strong>.</p><p>\u2022 Want both? Set Defaults to your ideal baseline, turn Session Memory on, uncheck the categories you want Defaults to win for.</p><hr class=\"cx-divider\"><p><em>Session Memory feature suggested by Railer.</em></p>",
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

  { id: "tools_touchup", title: "Touch-Up Tools", category: "canvas_tools",
    tags: ["smudge", "blur", "dodge", "burn", "pixelate", "touchup", "touch-up", "blend", "soften", "lighten", "darken", "censor"], shortcut: "S / R / J / P",
    content: "<p>Four brush-style tools for refining what\u2019s already on the canvas. They all share the brush\u2019s size and hardness controls; each adds its own <em>Strength</em> slider to control how aggressively it applies per stroke.</p><hr class=\"cx-divider\"><p><strong>Smudge</strong> <span class=\"cx-kbd\">S</span> \u2014 blends colors like wet paint. Drag to pull color in the direction of your stroke. Best for softening AI-generated edges that look too sharp \u2014 skin boundaries, hair edges, clothing folds. Strength around 30\u201350% gives the most controllable results.</p><hr class=\"cx-divider\"><p><strong>Blur</strong> <span class=\"cx-kbd\">R</span> \u2014 paints softness in place. Good for smoothing skin, softening backgrounds, or reducing noise in specific areas without affecting the whole image. Unlike Smudge, it doesn\u2019t move pixels \u2014 it only blurs them where you paint.</p><hr class=\"cx-divider\"><p><strong>Dodge / Burn</strong> <span class=\"cx-kbd\">J</span> \u2014 Dodge lightens, Burn darkens. Toggle between them in the context bar. Adjusts lighting without changing the underlying colors \u2014 great for adding depth, shadows, highlights, or correcting uneven lighting in generated images.</p><hr class=\"cx-divider\"><p><strong>Pixelate</strong> <span class=\"cx-kbd\">P</span> \u2014 paints a pixelated/mosaic effect into the brushed area. Pixel block size scales with brush size; Strength controls how strong the pixelation is per stroke (lower values blend partially with the original). Useful for censoring faces, license plates, or text in generated images, or for stylized 8-bit aesthetic edits.</p><hr class=\"cx-divider\"><p>All four tools work with selections \u2014 if a selection is active, edits are constrained to it. They also remember their settings independently per tool (see <em>Per-Tool Settings Memory</em>).</p>",
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
    content: "<p>Regional prompting lets you assign different descriptions to different areas of your canvas. Instead of one prompt for the whole image, you can say \"forest on the left, city on the right.\"</p><hr class=\"cx-divider\"><p><strong>Step by step:</strong></p><p>1. In the Generate tab, scroll to <em>Regions</em> and click <strong>+</strong> to add a region.</p><p>2. A new region appears with a color swatch and prompt field.</p><p>3. Switch to the brush (<span class=\"cx-kbd\">B</span>) and paint on the canvas. The region\u2019s color marks where it applies.</p><p>4. Type a prompt for this region \u2014 describe what should appear in the painted area.</p><p>5. Add more regions as needed. Each gets its own color and prompt.</p><p>6. Your <em>main prompt</em> still affects the whole image. Regions add local control on top.</p><p>7. Hit Generate.</p><hr class=\"cx-divider\"><p><strong>Tips:</strong></p><p>\u2022 Regions can overlap. Where they do, both prompts influence.</p><p>\u2022 Small regions work. Studio\u2019s system is specifically designed for this \u2014 small painted regions get their own content regardless of how much canvas area larger regions occupy.</p><p>\u2022 <strong>Leave unpainted gaps between regions.</strong> Those gaps act as coherence bridges \u2014 lighting, perspective, and style flow through the background. Painting regions edge-to-edge with no gap tends to produce harder seams.</p><p>\u2022 Use the main prompt for overall qualities (lighting, style) and regions for specific content. The main prompt is automatically prepended to each region.</p><p>\u2022 Don\u2019t forget to clear regions when done \u2014 they persist until removed.</p><p>For the technical architecture, see the <em>Attention Couple</em> entry below.</p>",
  },

  { id: "attention_couple", title: "Attention Couple (Architecture)", category: "advanced",
    tags: ["attention", "couple", "regional", "bounded", "self-attention", "cross-attention", "architecture", "softmax", "bias"],
    content: "<p><em>Attention Couple</em> is the name of the system that makes regional prompting work in Studio. You don\u2019t interact with it directly \u2014 you paint regions and it handles the rest. This entry is for the curious.</p><hr class=\"cx-divider\"><p><strong>What it does:</strong> When you paint multiple regions with different prompts, Attention Couple steers the model\u2019s internal attention so each region\u2019s content ends up where you painted it, without bleeding into the other regions.</p><hr class=\"cx-divider\"><p><strong>Why it\u2019s different from other regional systems:</strong> Approaches like Forge Couple, Regional Prompter, and ComfyUI node-based solutions generate separate outputs and blend them together, or bias the attention outputs after the fact. Studio biases the attention itself, before the softmax that decides what each pixel pays attention to. That means small painted regions actually get their own content instead of being washed out by larger neighbors.</p><hr class=\"cx-divider\"><p><strong>Why unpainted gaps matter:</strong> Studio also applies regional isolation on self-attention (pixel-to-pixel feature sharing). Without it, features leak laterally between subjects and you get heterochromia, hair color bleed, and other attribute mixing. Unpainted areas act as a shared background that every region can attend to, which is what lets perspective and lighting flow through the whole image coherently.</p>",
    deep: "<p>v7 architecture \u2014 dual-control pre-softmax biasing:</p><p>\u2022 <code>attn2_patch</code> + <code>attn2_replace</code>: cross-attention (text \u2192 spatial) pre-softmax logit bias. All region conditionings concatenated into one K tensor; Q @ K\u1d40 computed manually with a spatial bias matrix added before softmax. Bias scale tied to region area via <code>1/sqrt(frac)</code>, capped at 12.</p><p>\u2022 <code>attn1_replace</code>: self-attention (pixel \u2192 pixel) regional isolation bias. Same-region positions attend freely; cross-region attention is negatively biased (\u22128.0); background \u2194 anything attends freely. This is the coherence bridge.</p><p>\u2022 Uncond pass strips region tokens \u2014 if uncond attends to region content without bias, CFG cancels regional separation.</p><p>\u2022 <code>1\u2212t\u00b2</code> decay curve holds spatial control through the detail refinement phase.</p><p>\u2022 Global prompt is prepended to each region encoding. Gaussian feathering + bilinear downsampling on the region masks.</p><p>Inspired by Bounded Attention (Dahary et al., ECCV 2024) which proved cross-attention bias alone cannot prevent attribute leakage. First implementation of combined cross+self attention masking for regional prompting in the Forge/A1111 ecosystem. AD integration: each region carries <code>ad_prompt</code> (character-only, post-wildcard-resolution) so ADetailer inpaints single faces with clean per-character descriptions rather than the scene-level global prompt.</p>",
  },

  { id: "hires_fix", title: "HiRes Fix", category: "generation",
    tags: ["hires", "upscale", "upscaler", "detail", "resolution", "two-pass"],
    content: "<p>Two-pass generation: generates at normal size first, then upscales and adds detail. Produces much sharper results than generating at large resolution directly.</p><p><strong>Scale:</strong> enlargement factor (2.0 = double dimensions).</p><p><strong>Denoise:</strong> 0.2\u20130.4 for detail without changing content. Higher values reshape more.</p><p><strong>Steps:</strong> 0 = same as first pass.</p><p><strong>Upscaler:</strong> \"Latent\" = smooth/painterly feel. R-ESRGAN = sharp/detailed.</p>",
    deep: "<p>Base resolution \u2192 latent or pixel upscale \u2192 img2img at scaled resolution. Separate CFG and checkpoint overrides available for the second pass. Output dimensions = base \u00d7 scale; UI restores base dims after generation. HiRes + ADetailer = multiplicative cost \u2014 each adds a full pass.</p>",
  },

  { id: "live_painting", title: "Live Painting", category: "generation",
    tags: ["live", "painting", "realtime", "real-time", "paint", "loop", "continuous", "iterate", "img2img", "krita"],
    content: "<p>Paint on the canvas and watch the AI regenerate after every stroke. Studio treats your canvas as an img2img input and re-runs generation every time you stop painting.</p><hr class=\"cx-divider\"><p><strong>How to use it:</strong></p><p>1. Click the <strong>\u25b6 Live</strong> button next to the Generate button.</p><p>2. Paint on the canvas. Each time you release the pointer, Studio submits the current canvas and prompt and generates a result.</p><p>3. The result appears in the preview pane in the bottom-right of the viewport \u2014 not as a canvas layer. This keeps your paint work untouched while you compare.</p><p>4. Click <strong>Apply</strong> to commit the current preview to a new <code>[Live]</code> layer below your active layer. After apply, the seed re-rolls automatically so your next iteration explores a new variation.</p><p>5. Click <strong>\u25a0 Live</strong> again to stop.</p><hr class=\"cx-divider\"><p><strong>Controls while Live is active:</strong></p><p>\u2022 <strong>Seed lock</strong> \u2014 Live keeps the same seed across iterations so small canvas changes produce small, coherent result changes. Reroll it manually with the seed button if you want a fresh variation.</p><p>\u2022 <strong>Strength</strong> \u2014 the img2img denoise applied each iteration. Lower (0.2\u20130.4) = the AI respects your paint closely. Higher (0.5\u20130.7) = the AI takes more creative liberty. Adjust mid-session; Live re-submits on change.</p><p>\u2022 <strong>Prompt changes</strong> also trigger re-submission, with a short debounce so you can finish typing.</p><hr class=\"cx-divider\"><p><strong>Typical workflow:</strong> rough-paint a composition \u2192 Live cleans it up into an image \u2192 tweak the paint, let Live re-run \u2192 Apply when you like a result \u2192 paint over the applied layer to direct the next pass. This lets you steer generations by hand instead of by prompt.</p><hr class=\"cx-divider\"><p><strong>Things to know:</strong></p><p>\u2022 ADetailer auto-disables while Live is active \u2014 it\u2019s too expensive to run every iteration. It restores when you stop Live.</p><p>\u2022 Live submits on pointer-up (end of stroke), not continuously. Long strokes don\u2019t stack up multiple generations.</p><p>\u2022 Each iteration is a full diffusion run, so keep steps modest (10\u201315 is plenty for Live) and resolution reasonable (768\u00d7768 is a good default).</p>",
    deep: "<p>Completion-triggered img2img loop adapted from Krita AI Diffusion\u2019s approach. Frontend handles change detection (pointer-up hash diff), debounce (300ms canvas, 500ms prompt), and an adaptive watchdog timeout (2\u00d7 rolling average generation time, clamped 10\u201330s). Backend queue in <code>studio_live.py</code> drops stale requests when a new one arrives mid-generation. Preview compositing happens in <code>canvas-core.js</code> via <code>setLivePreview()</code> \u2014 results display in the existing viewport preview pane rather than as a canvas layer, so the preview can be discarded without touching user paint. <code>applyLivePreview()</code> creates the <code>[Live]</code> layer below the active layer so subsequent paint lands on top.</p>",
  },

  { id: "adetailer", title: "ADetailer", category: "generation",
    tags: ["adetailer", "face", "detail", "yolo", "hand", "detect", "auto"],
    content: "<p>Automatically detects faces (and optionally hands/bodies) in your generated image and regenerates them at higher detail. Fixes the most common AI problem \u2014 faces looking wrong or blurry at smaller sizes.</p><p>3 slots available. Slot 1 is pre-configured for face detection. Enable the checkbox and it runs automatically after generation.</p><p>Each slot has its own <em>prompt</em> (describe the face specifically), <em>confidence</em> (how sure the detector must be), and <em>denoise</em> (how much to change).</p><p>When used with regional prompting, each region\u2019s per-character prompt is automatically routed to the face inpainting step \u2014 the model fixing a specific character\u2019s face sees only that character\u2019s description, not the whole scene prompt.</p>",
    deep: "<p>Post-generation YOLO-based detection + inpainting pipeline. Per-slot flow: detect \u2192 crop region \u2192 inpaint at higher resolution \u2192 composite back. Models: face_yolov8n, hand_yolov8n, etc. Runs after HiRes Fix if both enabled. Studio\u2019s fork adds centroid-based region filtering so each detected face is matched to the region that contains its centroid, then inpainted with <code>ad_prompt</code> (character-only, post-wildcard-resolution text). An <code>is_hr_pass</code> discriminator distinguishes hires denoise from AD inner passes so attention couple stays active for hires but steps aside for single-face AD.</p>",
  },

  { id: "controlnet", title: "ControlNet", category: "advanced",
    tags: ["controlnet", "pose", "depth", "edge", "canny", "openpose", "reference", "structure"],
    content: "<p>ControlNet gives the AI structural guidance \u2014 \"follow this pose,\" \"use this edge map,\" \"keep this depth layout.\" It analyzes a source image and uses that structure to guide generation.</p><hr class=\"cx-divider\"><p><strong>Common use cases:</strong></p><p><em>Keep a pose:</em> Preprocessor \u2192 OpenPose, Model \u2192 OpenPose ControlNet. The AI follows the detected pose but creates new content.</p><p><em>Keep edges/lines:</em> Preprocessor \u2192 Canny, Model \u2192 Canny ControlNet. Maintains architectural layouts, mechanical designs, linework.</p><p><em>Keep depth layout:</em> Preprocessor \u2192 Depth, Model \u2192 Depth ControlNet. Foreground/background relationships stay the same.</p><hr class=\"cx-divider\"><p><strong>Key settings:</strong></p><p>\u2022 <strong>Weight</strong> (0.0\u20132.0): How strongly the structure guide affects the result. 1.0 = full.</p><p>\u2022 <strong>Source:</strong> Canvas (composite), Active Layer (just selected layer), or Upload (external image).</p><p>\u2022 <strong>Start/End:</strong> Which portion of denoising ControlNet is active. 0.0\u20130.5 gives structural guidance early without constraining fine details later.</p><p>Studio has 2 ControlNet units \u2014 combine them (e.g., pose + depth).</p><p><strong>Important:</strong> Preprocessor and model must match in type AND architecture (SD1.5 vs SDXL).</p>",
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
    tags: ["gallery", "browse", "search", "images", "output", "trackimage", "folder", "tag", "character", "scan", "watcher", "link"],
    content: "<p>Gallery is Studio\u2019s image library. It browses every generation you\u2019ve ever made, plus any other folder of images you point it at. New images appear in real time as they\u2019re saved \u2014 no refresh button.</p><hr class=\"cx-divider\"><p><strong>Getting started:</strong> First launch, Gallery asks you to pick a folder. Choose your Forge output folder (or any folder full of images) and it scans everything in it. You can link more folders later via <em>Link new folder</em> at the bottom of the sidebar.</p><hr class=\"cx-divider\"><p><strong>Layout:</strong></p><p>\u2022 <strong>Left sidebar</strong> \u2014 folder tree on top, character tag list below. Drag the column divider to resize. Click a folder or tag to filter; click again to clear.</p><p>\u2022 <strong>Top bar</strong> \u2014 search box and sort controls. Search matches filenames, character tags, and embedded metadata (prompt text, models, LoRAs). Autocomplete suggests known tags and metadata words as you type. Sort by filename, newest, or folder \u2014 click a sort button again to flip direction.</p><p>\u2022 <strong>Main grid</strong> \u2014 your images, infinite-scrolling. Click any image for the detail view.</p><hr class=\"cx-divider\"><p><strong>Character tags:</strong> Gallery auto-parses character names out of filenames using common patterns (underscores and dashes connect name parts, commas and plus signs separate characters). A file named <code>John_Doe+Jane_Smith_seed123.png</code> becomes tagged with <em>John Doe</em> and <em>Jane Smith</em>. The tag list in the sidebar groups tags by first letter.</p><p>You can manually add or remove tags per image from the detail view. See <em>Gallery Settings</em> in Gallery itself for the full tagging rules and the <em>ignore words</em> list (words that never become tags, like \"seed\" or \"sample\").</p><hr class=\"cx-divider\"><p><strong>Detail view:</strong> Click any image. You get full resolution, embedded metadata (prompt, settings, seed, LoRAs, sampler, everything stored in the PNG), character tags (editable), filename (editable), and action buttons for send-to-canvas, rename, move, delete, and open-in-explorer. Arrow keys navigate to adjacent images without closing the view.</p><hr class=\"cx-divider\"><p><strong>Real-time updates:</strong> The dot in the topbar shows watcher status. Green = connected, gray = disconnected. New generations appear in the grid within a second of being saved. Move, rename, or delete a file outside of Studio and Gallery picks it up too.</p><hr class=\"cx-divider\"><p><strong>Send to Canvas:</strong> Load any Gallery image onto your Studio canvas for editing. Also reads the embedded metadata \u2014 prompt, seed, and settings get restored so you can iterate from there.</p>",
    deep: "<p>Built on TrackImage by Moritz, integrated as Studio\u2019s Gallery module. Multi-folder scanning via linked <em>scan folders</em>. Filesystem watcher via <code>watchdog</code>; real-time updates via SSE at <code>/studio/gallery/events</code>. <code>suppress_path()</code> prevents duplicate events on rename/move/delete. SQLite backend with <code>PRAGMA busy_timeout=30000</code> for lock contention. Autocomplete endpoint at <code>/suggest</code>; metadata extracted from SD/ComfyUI/EXIF headers into an indexed <code>search_text</code> column. Video files get thumbnails via ffmpeg. Perceptual hashes (via imagehash) power the duplicate detector.</p>",
  },

  { id: "gallery_organize", title: "Organizing Images", category: "gallery",
    tags: ["organize", "select", "bulk", "rename", "move", "delete", "trash", "undo", "convert", "metadata", "strip", "drag", "clipboard", "copy", "cut", "paste", "tag"],
    content: "<p>Gallery supports bulk operations on multiple images at once. Everything is undoable.</p><hr class=\"cx-divider\"><p><strong>Selection:</strong></p><p>\u2022 <em>Click</em> an image \u2014 selects just that one.</p><p>\u2022 <em>Ctrl+Click</em> \u2014 toggles individual images in and out of the selection.</p><p>\u2022 <em>Shift+Click</em> \u2014 selects a range between the last-clicked image and the one you shift-click.</p><p>\u2022 A selection bar appears at the top of the grid showing the count and the bulk-action buttons.</p><hr class=\"cx-divider\"><p><strong>Bulk rename:</strong> Pick a base name; Gallery numbers multiple files automatically. Use underscores for multi-word character names and commas or plus signs to separate characters \u2014 <code>John_Doe+Jane_Smith</code> produces files that Gallery re-parses as two separate character tags. If a filename collision happens, Gallery offers to auto-increment or overwrite.</p><hr class=\"cx-divider\"><p><strong>Bulk move:</strong> Drag selected images onto any folder in the sidebar to move them there. You can also use the <em>Move</em> button in the selection bar to pick a destination from a folder picker. Both are undoable \u2014 <span class=\"cx-kbd\">Ctrl+Z</span> moves everything back.</p><hr class=\"cx-divider\"><p><strong>Bulk delete:</strong> Deleted images go to Gallery\u2019s trash \u2014 they\u2019re not hard-deleted immediately. <span class=\"cx-kbd\">Ctrl+Z</span> restores them. Trash is per-Gallery, separate from the OS recycle bin.</p><hr class=\"cx-divider\"><p><strong>Clipboard:</strong> Cut or copy a selection, then paste into a different folder \u2014 like file manager clipboard semantics, but scoped to Gallery. Cut moves, copy duplicates.</p><hr class=\"cx-divider\"><p><strong>Format conversion:</strong> Convert selected images between PNG, JPEG, and WebP. For formats without alpha (JPEG), you pick how transparency is handled \u2014 skip transparent files, or flatten to white or black. Option to keep originals or replace them. Option to strip in-file metadata during conversion.</p><hr class=\"cx-divider\"><p><strong>Strip metadata:</strong> Removes embedded EXIF / PNG metadata from the files on disk. Generation parameters stored in the Gallery database are preserved \u2014 the detail-view metadata panel keeps working. Use this before sharing images publicly if you don\u2019t want your prompt and settings going out with them.</p><hr class=\"cx-divider\"><p><strong>Tag editing (bulk):</strong> The <em>Tags</em> button in the selection bar opens a bulk tag editor. Shows tags that are common to all selected images, tags that only some have (with a count like 3/5), and lets you add or remove tags across the whole selection at once.</p><hr class=\"cx-divider\"><p><strong>Undo:</strong> <span class=\"cx-kbd\">Ctrl+Z</span> reverses the last Gallery operation \u2014 rename, move, delete, copy. The undo stack persists through the current session.</p><hr class=\"cx-divider\"><p><strong>Context menu:</strong> Right-click an image for the same actions (rename, move, delete, strip metadata, send to canvas, open in explorer). Right-click a folder in the sidebar for folder-level actions (rename, unlink \u2014 which removes the link without deleting files on disk).</p>",
  },

  { id: "gallery_duplicates", title: "Finding Duplicates", category: "gallery",
    tags: ["duplicate", "duplicates", "similar", "perceptual", "hash", "cleanup", "imagehash"],
    content: "<p>Gallery can find visually similar images across your library \u2014 not just exact file duplicates, but images that <em>look</em> the same. Useful when you\u2019ve generated the same concept repeatedly with different seeds, or ended up with near-identical outputs you forgot about.</p><hr class=\"cx-divider\"><p><strong>Running a scan:</strong> Open the duplicates view from the Gallery topbar. Gallery computes a perceptual hash for each image and groups ones that hash close together. Scans can take a while on large libraries \u2014 perceptual hashing is per-image, not something Gallery caches across sessions yet.</p><hr class=\"cx-divider\"><p><strong>Results view:</strong> Duplicates appear as <em>groups</em>. Each group shows the similar files side by side with thumbnails, filenames, and folder paths. A header shows the total \u2014 e.g. \"<em>12 groups \u00b7 38 files (keeping one per group would free 26 files)</em>\".</p><hr class=\"cx-divider\"><p><strong>Review and delete:</strong></p><p>\u2022 Each file has a checkbox. Check the ones you want to delete.</p><p>\u2022 Each group has a <strong>Select all but first</strong> button \u2014 fastest way to keep one copy per group and trash the rest.</p><p>\u2022 Deletions go to Gallery trash, undoable with <span class=\"cx-kbd\">Ctrl+Z</span>. If you decide you wanted one back, undo restores it.</p><hr class=\"cx-divider\"><p><strong>What counts as \"similar\":</strong> Perceptual hashing is tolerant of minor differences \u2014 small crops, compression, slight color shifts \u2014 so cropped and re-saved versions of the same image still cluster. It\u2019s not semantic similarity \u2014 two different generations of \"a red cat\" won\u2019t group unless they came out genuinely close-looking.</p><hr class=\"cx-divider\"><p><strong>Heads up:</strong> Duplicate detection requires the <code>imagehash</code> Python package. Studio installs it automatically on first launch, but if Forge failed to install it (offline install, pip issues), this view will tell you it\u2019s unavailable. Manual fix: <code>pip install imagehash</code> inside Forge\u2019s Python environment.</p>",
  },

  // ── VIDEO LAB ──────────────────────────────────────────────────

  { id: "video_lab_overview", title: "Video Lab", category: "video_lab",
    tags: ["video", "wan", "generation", "lab", "overview", "t2v", "i2v"],
    content: "<p>Video Lab is Studio\u2019s video generation module, built around the WAN family of video diffusion models. It generates short clips from a text prompt (T2V) or from a reference image plus a prompt (I2V).</p><hr class=\"cx-divider\"><p><strong>When to use it:</strong> Short motion clips, animated variations of a still image, test renders for longer pipelines. Not a replacement for traditional video editing \u2014 more of a seed-generator for motion.</p><hr class=\"cx-divider\"><p><strong>Basic flow:</strong></p><p>1. Open the <em>Video Lab</em> tab.</p><p>2. Load a WAN checkpoint in the Model section (see <em>Video Lab Models</em>).</p><p>3. Set duration (seconds), FPS, dimensions, steps.</p><p>4. Write a prompt describing the motion and scene.</p><p>5. Optional: drop a reference image for I2V, or configure enhancements (NAG, CFGZeroStar, etc.).</p><p>6. Hit Generate. Video output appears in the player with a thumbnail.</p><hr class=\"cx-divider\"><p><strong>VRAM:</strong> WAN models are heavier than image checkpoints. Expect 10\u201316 GB depending on quantization and resolution. On 16 GB use GGUF quants (Q5\u2013Q6). On 6\u20138 GB stick to WAN 2.2 5B with heavy quantization.</p><p><strong>FFmpeg:</strong> Required for video file output. Without it, Studio still captures frames but can\u2019t write a playable file \u2014 install FFmpeg and add it to PATH.</p>",
  },

  { id: "video_lab_models", title: "WAN Models & Loading", category: "video_lab",
    tags: ["wan", "model", "gguf", "fp16", "fp8", "dual", "expert", "refiner", "moe", "text encoder", "vae"],
    content: "<p>Video Lab uses its own model loader, separate from Studio\u2019s main checkpoint dropdown. That\u2019s because WAN models need a different text encoder (UMT5) and VAE than image checkpoints.</p><hr class=\"cx-divider\"><p><strong>What to load:</strong></p><p>\u2022 <strong>High Noise Model</strong> \u2014 the primary WAN checkpoint. Required.</p><p>\u2022 <strong>Low Noise Model</strong> (optional) \u2014 a second WAN checkpoint for dual-expert / MoE mode. The high-noise expert runs first, then Studio swaps in the low-noise expert at a configurable step for refinement.</p><p>\u2022 <strong>Text Encoder</strong> \u2014 UMT5 is auto-selected when present. Drop <code>.safetensors</code> or <code>.gguf</code> text encoders into <code>models/text_encoder/</code>.</p><p>\u2022 <strong>VAE</strong> \u2014 the WAN VAE. <strong>WAN 5B uses a different VAE from WAN 2.1 \u2014 they\u2019re not interchangeable.</strong></p><p>Click <em>Load Model</em> to apply. Switching away from Video Lab automatically restores your Canvas checkpoint.</p><hr class=\"cx-divider\"><p><strong>Formats:</strong></p><p>\u2022 <strong>GGUF quants</strong> (Q4, Q5, Q6, Q8) \u2014 best fit for most GPUs. Studio auto-forces fp16 LoRA mode for GGUF since these models can\u2019t re-quantize LoRA weights back to their native format.</p><p>\u2022 <strong>fp16</strong> \u2014 full precision, higher VRAM.</p><p>\u2022 <strong>fp8</strong> \u2014 <strong>warning:</strong> on Blackwell (RTX 50xx) with SageAttention 2, fp8 safetensors currently produce corrupted output. Use GGUF instead on those cards.</p><hr class=\"cx-divider\"><p><strong>Dual-expert / MoE:</strong> WAN 2.2 ships as two experts tuned for different noise regimes. Pick the high-noise one as the primary model, the low-noise one as the refiner. The DaSiWa FastFidelity community tunes (e.g. C-AiO BoundBite) work particularly well as the expert pair.</p>",
    deep: "<p>Dual-expert switching uses Forge\u2019s refiner mechanism with <code>refiner_fast_sd=True</code> \u2014 in-place <code>load_state_dict</code> swap, same model shell, no VRAM spike. The default <code>refiner_fast_sd=False</code> path triggers a full <code>forge_model_reload()</code> mid-sampling which OOMs on 16 GB cards. After each dual-expert generation Studio invalidates <code>model_data.forge_hash = \"\"</code> to avoid a stale hash on consecutive runs. Original weights are swapped back in a <code>finally</code> block wrapped in <code>torch.inference_mode()</code>.</p><p>When Video Lab loads a WAN checkpoint, it saves the pre-existing <code>forge_loading_parameters</code> so switching back to Canvas restores the image model rather than reloading WAN. The <code>/studio/api/video/deactivate</code> hook restores these parameters when the user leaves the tab.</p>",
  },

  { id: "video_lab_i2v", title: "Image-to-Video (I2V)", category: "video_lab",
    tags: ["i2v", "image", "video", "reference", "motion", "animate"],
    content: "<p>I2V animates a still image: provide a reference frame plus a motion prompt, and the model extrapolates movement forward.</p><hr class=\"cx-divider\"><p><strong>Setting up I2V:</strong></p><p>1. In the <em>Reference</em> panel, click <em>Upload</em> to pick a file, or <em>From Canvas</em> to grab whatever\u2019s on your Studio canvas right now.</p><p>2. The reference is resized to match your Video Lab width/height, so pick dimensions that are close to your source aspect ratio to avoid distortion.</p><p>3. Write a prompt describing the motion \u2014 \"slow zoom in, hair blowing in the wind, cinematic\" rather than just describing the content (which is already in the image).</p><p>4. If you have a low-noise expert loaded, I2V benefits from it for the refinement phase.</p><hr class=\"cx-divider\"><p><strong>Tips:</strong></p><p>\u2022 Good reference images have clear subject separation and decent contrast \u2014 muddy or low-contrast stills tend to produce unstable motion.</p><p>\u2022 The <em>last frame</em> button on the output player extracts the final frame as a PNG \u2014 feed it back in as a new reference to chain clips.</p><p>\u2022 Denoise at 1.0 for I2V is standard \u2014 the reference is the starting frame, not a strength-limited img2img target.</p>",
  },

  { id: "video_lab_enhancements", title: "Enhancements (NAG, CFGZeroStar, Sigma Shift, TeaCache)", category: "video_lab",
    tags: ["nag", "cfg zero star", "cfg", "sigma shift", "teacache", "enhancement", "quality", "speed"],
    content: "<p>Video Lab exposes several optional pipeline modifications. Each is independently toggleable.</p><hr class=\"cx-divider\"><p><strong>CFGZeroStar</strong> <em>(default: on)</em> \u2014 Zeros the unconditional branch for a small fraction of early steps and scales CFG dynamically. Improves prompt adherence without the oversaturation that classic high-CFG produces. Cheap \u2014 keep it on unless you\u2019re debugging.</p><hr class=\"cx-divider\"><p><strong>Sigma Shift</strong> <em>(default: on, shift=5.0)</em> \u2014 Rescales the flow-matching noise schedule. Higher shift = more sampling budget spent on global structure and less on fine detail. DaSiWa community recommendations: <strong>5.0 for I2V</strong>, <strong>10.0 for S2V</strong>. Stock WAN defaults around 3.0.</p><hr class=\"cx-divider\"><p><strong>NAG (Normalized Attention Guidance)</strong> <em>(off by default, ~2\u00d7 attention cost)</em> \u2014 Per-block attention extrapolation with L1 normalization. Improves negative-prompt adherence at CFG 1.0, where classic negative prompting has no effect. DaSiWa community values: <strong>scale 11.0, tau 2.37, alpha 0.25, start block 0</strong>. Expect roughly a 2\u00d7 slowdown on any block it\u2019s active for.</p><hr class=\"cx-divider\"><p><strong>TeaCache</strong> <em>(off by default)</em> \u2014 Caches transformer outputs between similar timesteps and reuses them when the input hasn\u2019t changed much. Threshold 0.2 is a safe default; 0.4+ loses detail. Most useful at 10+ steps \u2014 on 4-step DaSiWa models there are only ~2 candidate cacheable steps.</p><hr class=\"cx-divider\"><p><strong>Stacking:</strong> These compose. TeaCache wraps NAG safely (captures the existing unet wrapper and calls through). NAG captures whatever attention implementation is installed (including RadialAttention). Order: <em>apply NAG first, TeaCache after</em> \u2014 the stack is a wrapper chain, not a flat list.</p>",
    deep: "<p>CFGZeroStar \u2014 arxiv.org/abs/2503.18886. Implemented via <code>sampler_post_cfg_function</code> (singleton-safe, chains naturally with other post-CFG hooks).</p><p>Sigma shift stored in <code>p.distilled_cfg_scale</code> \u2014 read during infotext generation (processing.py line 733) and propagated to the noise schedule via <code>use_shift</code>. This is the correct sigma-shift entry point in Forge Neo; setting it anywhere else is ignored.</p><p>NAG \u2014 github.com/ChenDarYen/Normalized-Attention-Guidance. Hooks into WAN self-attention via <code>backend.nn.wan</code>. At each block \u2265 <code>start_block</code>, extrapolates between normal attention and zeroed-K/V attention (no-content baseline), then L1-normalizes the extrapolated output to stay on-manifold: <code>z_ext * (n_pos / n_ext).clamp(max=tau)</code>. Final output is <code>alpha * z_ext + (1-alpha) * z_pos</code>.</p><p>TeaCache \u2014 arxiv.org/abs/2411.19108 (CVPR 2025). Tracks relative L1 distance between consecutive inputs; when the accumulated distance stays under threshold, returns the cached residual instead of running the full transformer. First and last steps always compute.</p>",
  },

  { id: "video_lab_params", title: "Video Settings", category: "video_lab",
    tags: ["video", "params", "seconds", "fps", "frames", "dimensions", "steps", "cfg", "distilled"],
    content: "<p><strong>Duration (seconds) + FPS</strong> \u2014 Studio converts these to a frame count aligned to WAN\u2019s 4n+1 requirement. FPS 16 is the WAN-native rate; 24 and 30 are supported but re-time the same underlying frames.</p><hr class=\"cx-divider\"><p><strong>Dimensions:</strong></p><p>\u2022 <strong>832\u00d7480</strong> \u2014 standard 480p, cheap and fast.</p><p>\u2022 <strong>1280\u00d7720</strong> \u2014 720p, noticeably heavier.</p><p>\u2022 Odd aspect ratios work but require steps of 16 in each dimension.</p><hr class=\"cx-divider\"><p><strong>Steps and CFG:</strong></p><p>\u2022 DaSiWa FastFidelity checkpoints (C-AiO etc.) target <strong>4 steps</strong>. Adding steps past that rarely helps and can hurt.</p><p>\u2022 <strong>CFG 1.0</strong> effectively disables classic negative-prompt guidance \u2014 use <em>NAG</em> instead if you need negative adherence. Higher CFG tends to overcook motion.</p><hr class=\"cx-divider\"><p><strong>Sampler &amp; Scheduler:</strong> Default <em>Euler</em> + <em>Simple</em> scheduler is the standard WAN recipe. Deviate only if you know what you\u2019re testing.</p><hr class=\"cx-divider\"><p><strong>Post-upscale:</strong> Optional per-frame upscaler runs after generation. Community recommendation for WAN clips is <strong>latent upscaling</strong> (WAN 5B itself, or the spacepxl VAE-upscale-2x) rather than ESRGAN \u2014 video artifacts at the pixel level are different from still-image artifacts.</p>",
  },

  // ── WORKSHOP ───────────────────────────────────────────────────

  { id: "workshop_overview", title: "Workshop", category: "workshop",
    tags: ["workshop", "merge", "bake", "model", "checkpoint", "overview"],
    content: "<p>Workshop is Studio\u2019s model crafting suite. It lets you build new checkpoints by combining existing ones, bake LoRAs and VAEs into checkpoints permanently, and chain multiple operations together in a single recipe.</p><hr class=\"cx-divider\"><p><strong>What you can do:</strong></p><p>\u2022 <strong>Merge</strong> two or three checkpoints using any of a dozen methods (Weighted Sum, SLERP, Add Difference, TIES, DARE, STAR, SVD, Cosine Adaptive, Model Stock, and more).</p><p>\u2022 <strong>Bake LoRAs</strong> directly into a checkpoint so users don\u2019t need to load them separately.</p><p>\u2022 <strong>Bake VAEs</strong> into a checkpoint so users don\u2019t need to pick one.</p><p>\u2022 Chain multiple operations as a <strong>recipe</strong> \u2014 merge A and B, bake a LoRA into the result, swap the VAE, save. One recipe, one output.</p><hr class=\"cx-divider\"><p><strong>Two modes per operation:</strong></p><p>\u2022 <em>Test Merge</em> \u2014 hot-swaps the new weights into memory without writing a file. Generate test images to judge the result before committing.</p><p>\u2022 <em>Save to Disk</em> \u2014 writes the final checkpoint as <code>.safetensors</code>.</p><hr class=\"cx-divider\"><p>Every completed merge or bake auto-logs to the <em>Journal</em> (see the entry on that below) with its full recipe, so you can reproduce any experiment later.</p>",
  },

  { id: "workshop_methods", title: "Merge Methods", category: "workshop",
    tags: ["weighted sum", "slerp", "add difference", "ties", "dare", "della", "star", "svd", "cosine", "model stock", "method"],
    content: "<p>Workshop offers a menu of merge methods, each with its own strengths. Pick based on what you\u2019re trying to achieve, not by instinct \u2014 the differences are real.</p><hr class=\"cx-divider\"><p><strong>Basic blending:</strong></p><p>\u2022 <strong>Weighted Sum</strong> \u2014 linear interpolation between A and B per alpha. Simplest, fastest, always works. Start here.</p><p>\u2022 <strong>SLERP</strong> \u2014 spherical interpolation. Preserves the magnitude of weight vectors instead of averaging them. Usually produces sharper, more vibrant results than Weighted Sum at the same alpha. Best when blending two models of similar quality.</p><hr class=\"cx-divider\"><p><strong>Training transplant:</strong></p><p>\u2022 <strong>Add Difference</strong> \u2014 extracts what B learned relative to its base model C, then applies that training to A. Use this to transplant a finetune\u2019s skills (e.g. anime style, specific subject) into a different model. Requires Model C \u2014 the base B was finetuned from.</p><hr class=\"cx-divider\"><p><strong>Noise-filtered merges (for messy finetunes):</strong></p><p>\u2022 <strong>TIES</strong> \u2014 Trim, Elect Sign &amp; Merge. Extracts B\u2019s training over A, trims the weakest changes, keeps only significant ones. Cleaner than Weighted Sum when B is overtrained.</p><p>\u2022 <strong>DARE</strong> \u2014 randomly drops a fraction of B\u2019s training delta, rescales the rest. Same goal as TIES with a different noise model.</p><p>\u2022 <strong>DELLA</strong> \u2014 like DARE but drop probability is magnitude-weighted, so large important changes survive while small noisy ones are more likely to be removed. Slightly more reliable than uniform DARE.</p><p>\u2022 <strong>DARE-TIES</strong> \u2014 combines both.</p><hr class=\"cx-divider\"><p><strong>Spectral methods:</strong></p><p>\u2022 <strong>STAR (Spectral)</strong> \u2014 Spectral Truncation and Rescale. Decomposes B\u2019s training via SVD and strips noisy spectral components. Produces cleaner results from overtrained or messy finetunes. Safe range: lambda 0.3\u20130.5 with eta 0.1. Lambda 1.0 corrupts output.</p><p>\u2022 <strong>SVD: Structure A + Mag B / Structure B + Mag A</strong> \u2014 decomposes both via SVD and recombines. \"Structure\" is what a layer detects; \"magnitude\" is how strongly it responds. Swap them independently \u2014 results are impossible via weight averaging.</p><p>\u2022 <strong>SVD: Spectral Blend</strong> \u2014 Procrustes-aligns both models\u2019 spectral decompositions, then interpolates structure and magnitude together in spectral space. Smoother than Weighted Sum because it respects geometric relationships between feature directions.</p><hr class=\"cx-divider\"><p><strong>Adaptive:</strong></p><p>\u2022 <strong>Cosine Adaptive</strong> \u2014 computes per-tensor cosine similarity between A and B, uses similar tensors for higher blend weight (they agree, safe to merge) and dissimilar ones for lower weight (they disagree, merging would average useful signal into noise).</p><p>\u2022 <strong>Model Stock</strong> \u2014 no alpha required. Computes the optimal blend automatically from the models themselves.</p><hr class=\"cx-divider\"><p><strong>When in doubt:</strong> Weighted Sum 0.5 is always a reasonable baseline. If results look washed out, try SLERP next. If you\u2019re merging a specific finetune of a known base, use Add Difference. If one of the inputs is visibly overtrained, use STAR or TIES.</p>",
  },

  { id: "workshop_block_weights", title: "Block Weights", category: "workshop",
    tags: ["block", "weight", "layer", "input", "middle", "output", "attention"],
    content: "<p>Instead of merging every layer of the model at the same alpha, <em>block weights</em> let you assign different alphas to different parts of the UNet. This gives you much finer control over what gets merged where.</p><hr class=\"cx-divider\"><p><strong>Block structure (SDXL):</strong></p><p>\u2022 <strong>Input blocks</strong> \u2014 early layers process the noisy latent. Later input blocks handle structural features, composition, and layout.</p><p>\u2022 <strong>Middle</strong> \u2014 the bottleneck. Most compressed representation of the image, the model\u2019s core understanding. Affects global coherence.</p><p>\u2022 <strong>Output blocks</strong> \u2014 expand back to full resolution. Early output blocks = structure, later = fine details and rendering quality.</p><hr class=\"cx-divider\"><p><strong>Common patterns:</strong></p><p>\u2022 <em>Keep A\u2019s composition, use B\u2019s rendering</em> \u2014 low alpha on input and middle blocks, high alpha on late output blocks.</p><p>\u2022 <em>Keep A\u2019s style, use B\u2019s subject knowledge</em> \u2014 opposite: high alpha on input/middle, low on output.</p><p>\u2022 <em>Transplant faces only</em> \u2014 very localized block weights on the blocks that tend to encode face features.</p><hr class=\"cx-divider\"><p>Block weights work with Weighted Sum, SLERP, Add Difference, STAR, and all SVD methods. TIES, DARE, and DELLA operate on the whole model at once and ignore block weights.</p>",
  },

  { id: "workshop_lora_bake", title: "LoRA Baking", category: "workshop",
    tags: ["lora", "bake", "merge", "checkpoint", "adapter", "loha", "lokr", "oft", "boft", "glora", "dora"],
    content: "<p>LoRA baking permanently merges a LoRA (or several) into a checkpoint. The result is a single <code>.safetensors</code> file that behaves as if the LoRA is always active at the baked strength \u2014 no <code>&lt;lora:...&gt;</code> tags needed.</p><hr class=\"cx-divider\"><p><strong>When to bake instead of loading as a LoRA:</strong></p><p>\u2022 You always use this LoRA with this checkpoint.</p><p>\u2022 You want to distribute the result as a self-contained model.</p><p>\u2022 You\u2019re stacking multiple LoRAs and want a simpler runtime setup.</p><p>\u2022 You want the LoRA\u2019s effect at a weight not expressible at load time (e.g. bake at 0.7 plus another at 0.4 for a specific blend).</p><hr class=\"cx-divider\"><p><strong>Supported adapter types:</strong> LoRA, LoHa, LoKr, OFT, BOFT, GLoRA, DoRA, plus raw <code>diff</code> and <code>set</code> patches. Studio auto-detects the adapter type per file from its key suffixes \u2014 you don\u2019t have to tell it what kind of LoRA you\u2019re baking.</p><hr class=\"cx-divider\"><p><strong>Tips:</strong></p><p>\u2022 Bake at a strength you\u2019ve tested first. There\u2019s no slider at runtime after baking \u2014 you\u2019re locked in.</p><p>\u2022 Architecture must match. An SDXL LoRA won\u2019t bake into an SD 1.5 checkpoint.</p><p>\u2022 Multiple LoRAs in a recipe are applied <em>sequentially</em>, so order can matter for non-linear adapter types.</p>",
    deep: "<p>All math performed in fp32 to avoid precision loss, downcast only at save. VAE keys always stay fp32 regardless of checkpoint format. Key matching uses four strategies: the standard Kohya <code>lora_unet_*</code>/<code>lora_te*_*</code> prefix convention, Flux/SD3 direct format, generic <code>base.weight</code> matching, and a full CompVis\u2194diffusers prefix table for SDXL diffusers-format LoRAs. DoRA decomposition is detected via <code>dora_scale</code> keys and applied via the standard weight-norm rescaling after the delta is added.</p>",
  },

  { id: "workshop_vae_bake", title: "VAE Baking", category: "workshop",
    tags: ["vae", "bake", "checkpoint", "color"],
    content: "<p>VAE baking replaces the VAE embedded in a checkpoint with a different one. The result is a checkpoint that always uses the new VAE \u2014 users don\u2019t have to pick one from the dropdown.</p><hr class=\"cx-divider\"><p><strong>When to use it:</strong></p><p>\u2022 Your favorite checkpoint has baked-in color/saturation issues and a specific VAE fixes them (e.g. <code>vae-ft-mse-840000</code> on many SD 1.5 checkpoints).</p><p>\u2022 You\u2019re distributing a checkpoint and want it to \"just work\" without VAE setup.</p><p>\u2022 You\u2019re building a self-contained recipe with merges, LoRA bakes, and a specific VAE all rolled into one file.</p><hr class=\"cx-divider\"><p>VAE architecture must match checkpoint architecture. SDXL VAE into SD 1.5 checkpoint won\u2019t work. WAN 5B and WAN 2.1 use different VAEs \u2014 don\u2019t cross them.</p>",
  },

  { id: "workshop_journal", title: "Journal & Recipes", category: "workshop",
    tags: ["journal", "history", "recipe", "rating", "tag", "note", "chain"],
    content: "<p>Every completed merge, LoRA bake, VAE bake, and chain run auto-logs to the <em>Journal</em> with its full recipe. You get a searchable history of every experiment you\u2019ve ever run.</p><hr class=\"cx-divider\"><p><strong>Per-entry:</strong></p><p>\u2022 Full recipe (method, alpha, models involved, block weights, parameters).</p><p>\u2022 Timestamp and elapsed time.</p><p>\u2022 Editable <em>rating</em> (0\u20135 stars), <em>tags</em>, and <em>notes</em>.</p><p>\u2022 Optional <em>sample image</em> \u2014 attach a test generation to remember what this merge actually looked like.</p><hr class=\"cx-divider\"><p><strong>Search &amp; filter:</strong> by text (searches name, notes, and recipe contents), by tag, or by type (merge / LoRA bake / VAE bake / note). You can also add manual notes for models you didn\u2019t make in Workshop but want to track.</p><hr class=\"cx-divider\"><p><strong>Recipes</strong> are saved chain configurations \u2014 a sequence of merge/bake steps that reference previous step outputs as <code>__O1__</code>, <code>__O2__</code>, etc. Save a recipe once, run it against different input models any time. Intermediate outputs are auto-deleted unless you check <em>Save intermediates</em>.</p>",
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
    content: "<p><strong>Speech bubbles:</strong> Click to add. Multiple styles available (rounded, thought cloud, shout). Edit text inline by double-clicking. Each bubble has its own font, size, and style.</p><p><strong>Font picker:</strong> sans-serif, serif, monospace, Comic Sans, Bangers, Permanent Marker, Creepster, Special Elite, Impact. Web fonts fall back gracefully if Google Fonts aren\u2019t loaded.</p><p><strong>SFX text:</strong> Bold text with thick stroke outline, no bubble shape. Defaults to Impact, 36px, yellow (#FFD600) with 4px black stroke. Great for \"BOOM!\", \"CRASH!\", \"ZAP!\" effects. Text stroke controls (width and color) are available on all bubble styles.</p><p><strong>Layer ordering:</strong> Four buttons (\u2913\u2193\u2191\u2912) reorder bubbles. Keyboard: <span class=\"cx-kbd\">]</span> forward, <span class=\"cx-kbd\">[</span> back, <span class=\"cx-kbd\">Shift+]</span> front, <span class=\"cx-kbd\">Shift+[</span> back.</p>",
  },

  { id: "comic_pages", title: "Multi-Page & Export", category: "comic_lab",
    tags: ["comic", "page", "multipage", "export", "pdf", "png"],
    content: "<p><strong>Multi-page:</strong> Each page is fully isolated \u2014 its own panels, bubbles, dimensions, background color, and undo stack. The page strip at the bottom shows numbered tabs. <strong>+</strong> adds a page after the current one. Right-click for duplicate/delete.</p><p><span class=\"cx-kbd\">Ctrl+PageUp/PageDown</span> navigates between pages.</p><hr class=\"cx-divider\"><p><strong>Export:</strong></p><p>\u2022 <strong>PNG</strong> (<span class=\"cx-kbd\">Ctrl+E</span>) \u2014 current page, full resolution. No selection highlights.</p><p>\u2022 <strong>PDF</strong> (<span class=\"cx-kbd\">Ctrl+Shift+E</span>) \u2014 all pages. Each page rendered to JPEG and embedded. Zero dependencies.</p><hr class=\"cx-divider\"><p><strong>Save/Load:</strong> <span class=\"cx-kbd\">Ctrl+S</span> saves as <code>.comic.json</code>. Drag and drop a <code>.comic.json</code> onto the canvas to load. V1 single-page files auto-upgrade on load.</p>",
  },

  // ── TROUBLESHOOTING ────────────────────────────────────────────

  { id: "common_problems", title: "Common Problems", category: "troubleshooting",
    tags: ["problem", "error", "black", "artifact", "broken", "fix", "slow", "load", "seed"],
    content: "<p><strong>Black image:</strong> Model didn\u2019t load or VRAM ran out. Check status bar \u2014 reload model from dropdown, reduce dimensions, or disable HiRes Fix.</p><p><strong>Garbled/noisy result:</strong> CFG too high or wrong model for your settings. Lower CFG to 5\u20137. SDXL models need at least 768\u00d7768.</p><p><strong>Generation is very slow:</strong> Steps + HiRes Fix + ADetailer are multiplicative. Each adds a full pass. Disable what you don\u2019t need.</p><p><strong>Model takes forever to load:</strong> The first time you load a model, Forge may need to download additional components (text encoders, VAE, safety checker files). This is a one-time download per model architecture. Subsequent loads are fast.</p><p><strong>Same image every time:</strong> Your seed is locked. Check the Seed field \u2014 if it\u2019s not -1, click the <strong>dice button</strong> to re-enable random seeds.</p><p><strong>Wrong colors / washed out:</strong> Try a different VAE in the dropdown.</p><p><strong>\"Disconnected\" in status bar:</strong> WebSocket dropped. Refresh the page. If persistent, check the Forge terminal for errors.</p><p><strong>Extra fingers / bad anatomy:</strong> Common AI artifact. Use ADetailer for faces. Add \"bad hands, extra fingers\" to negatives. Inpaint specific problem areas manually.</p><p><strong>LoRA has no effect:</strong> Architecture mismatch (SD1.5 LoRA on SDXL model), missing trigger word, or weight too low.</p><p><strong>ControlNet error on RTX 5000 series:</strong> Some preprocessors (especially Depth Anything) crash due to xformers not supporting CUDA capability 12.0. Use Canny or other preprocessors that don\u2019t rely on xformers.</p><p><strong>Video Lab I2V / inpainting fails on Mac (MPS):</strong> <code>aten::hash_tensor.out</code> is not implemented for MPS in PyTorch 2.10+. Set the environment variable <code>PYTORCH_ENABLE_MPS_FALLBACK=1</code> before launching Forge. T2V still works; I2V and inpainting will route to CPU for the unsupported op.</p><p><strong>Video Lab corrupted output on RTX 50xx:</strong> fp8 WAN safetensors with SageAttention 2 produce garbage on Blackwell. Switch to a GGUF quant of the same model.</p>",
  },

  { id: "vram_management", title: "VRAM Management", category: "troubleshooting",
    tags: ["vram", "memory", "gpu", "unload", "low", "snekysnek"],
    content: "<p>VRAM is your GPU\u2019s memory. The loaded model is the biggest user (4\u20138 GB). Status bar shows current usage, color-coded: green (&lt;60%), amber (60\u201385%), red (&gt;85%).</p><p><strong>Running low?</strong> Reduce image dimensions (768 instead of 1024), keep Batch Size at 1, disable HiRes Fix and ControlNet when not in use.</p><p><strong>Unloading:</strong> Settings \u2192 VRAM \u2192 Unload Model frees all VRAM. Auto-unload does this after an idle timeout (configurable 5\u201330 minutes). The model reloads on next generation. <em>Feature suggested by SnekySnek.</em></p><p><strong>GGUF notes:</strong> On 16 GB cards, avoid <code>--reserve-vram 2</code> with GGUF checkpoints \u2014 it forces full model offloading and tanks performance.</p>",
    deep: "<p>VRAM monitoring via <code>/studio/vram</code>. Manual unload via <code>/studio/unload_model</code>. Auto-unload fires via WebSocket after configurable idle timeout. SDXL ~6\u20137 GB, SD1.5 ~4 GB, ControlNet +1\u20132 GB per loaded unit, HiRes 2\u00d7 = 4\u00d7 latent tensor during second pass.</p>",
  },

  { id: "low_vram_optimization", title: "Low-VRAM Performance Checklist", category: "troubleshooting",
    tags: ["vram", "6gb", "8gb", "slow", "upscale", "memory", "rtx2060", "gtx1660", "optimization", "lowvram"],
    content: "<p>Running SDXL on 6-8 GB cards can feel painfully slow if Forge's memory manager is being forced into aggressive offloading. Symptoms: base generation is fine but upscale takes 5+ minutes, hires denoise runs at 20+ s/it instead of 1-3 s/it, system RAM hits 85%+ during upscale, SSD activity spikes during generation.</p><hr class=\"cx-divider\"><p><strong>Launch args to avoid on low-VRAM cards:</strong></p><p>\u2022 <code>--reserve-vram 1.5</code> (or any value above 1.0) \u2014 forces partial model offload on every sampling step. Modern Forge Neo's adaptive memory manager handles 6GB SDXL without manual reserve; the flag actively hurts performance.</p><p>\u2022 <code>--cuda-stream</code> on RTX 2060 / GTX 1080 / GTX 1660 \u2014 Forge's creator documents this produces NaN/black outputs on Turing cards. Use the <code>Forge_Studio_LowVRAM.bat</code> launcher (which doesn't carry this flag) instead of the regular one.</p><hr class=\"cx-divider\"><p><strong>Forge Settings to enable:</strong></p><p>\u2022 Settings \u2192 Upscaling \u2192 <strong>Composite the Tiles on GPU</strong>. Off by default. Moves tile stitching from CPU to GPU, cutting upscale time from ~17s to ~4s on typical setups.</p><p>\u2022 Settings \u2192 Upscaling \u2192 <strong>Prefer to load Upscaler in half precision</strong>. Halves the upscaler model's VRAM footprint. Requires a restart.</p><hr class=\"cx-divider\"><p><strong>Resolution guidance for 6 GB cards:</strong></p><p>\u2022 <strong>Safe:</strong> 768\u00d7768 base + 1.5x upscale + refine + ADetailer. Full pipeline runs in ~90 seconds after the fixes above.</p><p>\u2022 <strong>Sweet spot:</strong> 896\u00d7896 base + 1.5x upscale + full pipeline. Usually fits if you're not running other VRAM-heavy apps.</p><p>\u2022 <strong>Tight:</strong> 1024\u00d71024 base \u2014 base gen alone is fine, but 1.5x upscale to 1536\u00b2 often pushes refine into offload territory. Drop upscale to 1.25x, or skip refine, or stick to 896.</p><hr class=\"cx-divider\"><p><strong>Studio VRAM Reserve slider:</strong> Settings \u2192 VRAM \u2192 VRAM Reserve. Leave at <strong>Auto (0)</strong>. Manually setting a reserve on a 6GB card usually makes things slower, not faster, because it shrinks the model-weights budget. Only increase it if you're hitting actual OOM crashes \u2014 start with 0.8 GB, not higher.</p>",
    deep: "<p>Root cause: Forge's built-in memory manager reserves ~1 GB of VRAM for inference workspace by default (<code>minimum_inference_memory</code>). Adding <code>--reserve-vram 1.5</code> stacks another 1.5 GB on top, leaving ~3.5 GB of a 6 GB card for model weights. Since SDXL's UNet is ~5 GB, this forces 1.5+ GB of model to live in system RAM and get shuttled to VRAM on every forward pass. PCIe bandwidth becomes the bottleneck instead of GPU compute, producing the 10x slowdown symptom.</p><p>On 16 GB+ cards this doesn't happen because there's plenty of room for both the full model and workspace, so the flag has no measurable effect. It's specifically a low-VRAM footgun.</p>" },

  // ── SHORTCUTS ──────────────────────────────────────────────────

  { id: "shortcuts_tools", title: "Tool Shortcuts", category: "shortcuts",
    tags: ["shortcut", "keyboard", "hotkey", "tool"],
    content: "<p><span class=\"cx-kbd\">B</span> Brush \u2022 <span class=\"cx-kbd\">E</span> Eraser \u2022 <span class=\"cx-kbd\">I</span> Eyedropper \u2022 <span class=\"cx-kbd\">G</span> Fill/Gradient \u2022 <span class=\"cx-kbd\">U</span> Shape \u2022 <span class=\"cx-kbd\">T</span> Text</p><p><span class=\"cx-kbd\">S</span> Smudge \u2022 <span class=\"cx-kbd\">R</span> Blur \u2022 <span class=\"cx-kbd\">J</span> Dodge/Burn \u2022 <span class=\"cx-kbd\">K</span> Clone \u2022 <span class=\"cx-kbd\">Y</span> Liquify \u2022 <span class=\"cx-kbd\">P</span> Pixelate</p><p><span class=\"cx-kbd\">M</span> Rect select \u2022 <span class=\"cx-kbd\">O</span> Ellipse select \u2022 <span class=\"cx-kbd\">L</span> Lasso \u2022 <span class=\"cx-kbd\">W</span> Wand \u2022 <span class=\"cx-kbd\">C</span> Crop \u2022 <span class=\"cx-kbd\">V</span> Transform</p><p><span class=\"cx-kbd\">Q</span> Toggle mask mode \u2022 <span class=\"cx-kbd\">D</span> Reset colors \u2022 <span class=\"cx-kbd\">X</span> Swap FG/BG</p>",
  },

  { id: "shortcuts_canvas", title: "Canvas & Editing Shortcuts", category: "shortcuts",
    tags: ["shortcut", "keyboard", "undo", "zoom", "pan", "clipboard", "delete", "backspace", "reset", "tab", "document"],
    content: "<p><span class=\"cx-kbd\">Ctrl+Z</span> Undo \u2022 <span class=\"cx-kbd\">Ctrl+Shift+Z</span> Redo</p><p><span class=\"cx-kbd\">Ctrl+A</span> Select all \u2022 <span class=\"cx-kbd\">Ctrl+D</span> Deselect \u2022 <span class=\"cx-kbd\">Ctrl+Shift+I</span> Invert selection</p><p><span class=\"cx-kbd\">Ctrl+C/X/V</span> Copy/Cut/Paste</p><p><span class=\"cx-kbd\">Del</span> / <span class=\"cx-kbd\">Backspace</span> \u2014 context-sensitive:</p><p>\u2022 Active transform \u2192 cancel transform, discard its contents.</p><p>\u2022 Active selection \u2192 clear pixels inside the selection.</p><p>\u2022 No selection, no transform \u2192 <strong>resets the canvas</strong> \u2014 removes all layers and creates a fresh white Background. Undoable with <span class=\"cx-kbd\">Ctrl+Z</span>.</p><p><span class=\"cx-kbd\">Ctrl+Enter</span> Generate \u2022 <span class=\"cx-kbd\">\\</span> Toggle panel</p><p><span class=\"cx-kbd\">Ctrl+]</span> / <span class=\"cx-kbd\">Ctrl+[</span> Cycle documents</p><p><span class=\"cx-kbd\">F</span> or <span class=\"cx-kbd\">0</span> Zoom to fit \u2022 <span class=\"cx-kbd\">Scroll</span> Zoom \u2022 <span class=\"cx-kbd\">Space+Drag</span> Pan</p><p><span class=\"cx-kbd\">[</span>/<span class=\"cx-kbd\">]</span> Brush size \u2022 <span class=\"cx-kbd\">{</span>/<span class=\"cx-kbd\">}</span> Brush hardness \u2022 <span class=\"cx-kbd\">Shift+Drag</span> Size + opacity adjust</p><p><span class=\"cx-kbd\">Ctrl+Click</span> Eyedropper from any tool \u2022 <span class=\"cx-kbd\">Alt+Click</span> Clone source</p><p><span class=\"cx-kbd\">Ctrl+Shift+N</span> New layer \u2022 <span class=\"cx-kbd\">Ctrl+J</span> Duplicate layer \u2022 <span class=\"cx-kbd\">Ctrl+E</span> Merge down \u2022 <span class=\"cx-kbd\">Ctrl+Shift+E</span> Flatten</p><p><span class=\"cx-kbd\">Enter</span> Commit transform \u2022 <span class=\"cx-kbd\">Escape</span> Cancel / deselect</p>",
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
    { id: "tutorials_and_tours", label: "Interactive Tutorials",   desc: "Learn by doing" },
    { id: "canvas_routing",      label: "Canvas Routing",          desc: "How Studio decides what to do" },
    { id: "models_and_vae",      label: "Models & VAE",            desc: "Getting started" },
    { id: "inpaint_basics",      label: "Editing Parts of Images", desc: "Inpainting guide" },
    { id: "loras",               label: "LoRAs",                   desc: "Style & character add-ons" },
    { id: "regional_prompting",  label: "Regional Prompting",      desc: "Multi-zone control" },
    { id: "video_lab_overview",  label: "Video Lab",               desc: "WAN video generation" },
    { id: "workshop_overview",   label: "Workshop",                desc: "Merging & baking models" },
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
    btn.innerHTML = "?";
    btn.addEventListener("click", function (ev) { ev.preventDefault(); _togglePopover(); });
    if (spacer) toolstrip.insertBefore(btn, spacer);
    else toolstrip.appendChild(btn);
  }

  // Popover container
  _popover = document.createElement("div");
  _popover.id = "cxPopover";
  _popover.className = "cx-popover";
  _popover.innerHTML =
    '<div class="cx-pop-header">' +
      '<input type="text" class="cx-pop-search" id="cxPopSearch" placeholder="Search the Codex..." autocomplete="off">' +
      '<button class="cx-pop-close" id="cxPopClose" title="Close">\u00d7</button>' +
    '</div>' +
    '<div class="cx-pop-body">' +
      '<div class="cx-pop-results" id="cxPopResults" style="display:none;"></div>' +
      '<div class="cx-pop-article" id="cxPopArticle"></div>' +
    '</div>';
  studio.appendChild(_popover);

  _popEls.search = _popover.querySelector("#cxPopSearch");
  _popEls.close = _popover.querySelector("#cxPopClose");
  _popEls.results = _popover.querySelector("#cxPopResults");
  _popEls.article = _popover.querySelector("#cxPopArticle");

  _popEls.close.addEventListener("click", _hidePopover);
  _popEls.search.addEventListener("input", function () {
    var q = _popEls.search.value;
    if (q.trim().length === 0) {
      _popRenderHome();
    } else {
      _popRenderResults(_search(q));
      _popEls.results.style.display = "block";
      _popEls.article.style.display = "none";
    }
  });

  // ? key toggles popover (when not in an input)
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "?" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      var tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      ev.preventDefault();
      _togglePopover();
    } else if (ev.key === "Escape" && _popVisible) {
      _hidePopover();
    }
  });
}

function _togglePopover() {
  if (_popVisible) _hidePopover();
  else _showPopover();
}

function _showPopover() {
  if (!_popover) return;
  _popover.classList.add("visible");
  _popVisible = true;
  _popRenderHome();
  setTimeout(function () { if (_popEls.search) _popEls.search.focus(); }, 50);
}

function _hidePopover() {
  if (!_popover) return;
  _popover.classList.remove("visible");
  _popVisible = false;
  if (_popEls.search) _popEls.search.value = "";
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
