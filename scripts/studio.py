"""
Forge Studio v4.0
by ToxicHost & Moritz

Gradio tab — minimal launcher that points users to the standalone UI at /studio.
All canvas, generation, and module functionality lives in the standalone frontend.
This file only provides:
  1. A Gradio tab with an "Open Forge Studio" button
  2. The on_app_started hook that registers API routes via studio_api.py
"""

import gradio as gr
import modules.scripts as scripts

# =========================================================================
# Import the API setup hook (dual-import pattern)
# =========================================================================

try:
    from scripts.studio_api import add_studio_api
except ImportError:
    try:
        from studio_api import add_studio_api
    except ImportError:
        # Fallback: try the old location in studio_generation.py
        try:
            from scripts.studio_generation import add_studio_api
        except ImportError:
            from studio_generation import add_studio_api


# =========================================================================
# Gradio Tab — Redirect to Standalone UI
# =========================================================================

def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as studio_tab:
        gr.HTML(value="""
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;min-height:200px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#e0dfd8;margin-bottom:8px;">Forge Studio</div>
          <div style="font-size:12px;color:#9c9a92;margin-bottom:20px;max-width:400px;">
            Full canvas editor with layers, brushes, regional prompting, ADetailer, ControlNet, and more.
          </div>
          <button onclick="window.open('/studio','_blank')"
            style="padding:10px 32px;background:#7b8fff;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:filter 0.15s;"
            onmouseover="this.style.filter='brightness(1.15)'"
            onmouseout="this.style.filter=''">
            Open Forge Studio
          </button>
          <div style="font-size:10px;color:#6b6b74;margin-top:12px;">Opens in a new tab at /studio</div>
        </div>
        """)

    return [(studio_tab, "Studio", "forge_studio_tab")]


scripts.script_callbacks.on_ui_tabs(on_ui_tabs)

# =========================================================================
# API Route Registration
# =========================================================================

try:
    scripts.script_callbacks.on_app_started(add_studio_api)
except Exception:
    pass  # Non-critical: standalone UI just won't be served
