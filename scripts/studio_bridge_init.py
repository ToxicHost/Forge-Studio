"""
Forge Studio — Extension Bridge (Self-Contained)
=================================================
Populates ScriptRunner UI args in --nowebui (standalone) mode.

Problem: When Forge Neo runs with --nowebui, setup_ui() never gets called
on the ScriptRunners, so extension scripts have empty .inputs and no arg
indices. Every extension that reads script_args via slicing crashes.

Solution: Register a before_ui callback that installs gradio stubs and
calls setup_ui() ourselves. This runs in stock Forge Neo's api_only_worker()
— no modifications to webui.py required.

This script replaces the Extension Bridge block that was previously
hard-coded into a modified webui.py.
"""

import importlib.util
import os

from modules import script_callbacks
from modules.shared_cmd_options import cmd_opts


def _init_extension_bridge():
    """Initialize the extension bridge for standalone mode.

    Only runs when --nowebui is active. Idempotent — safe to call
    multiple times (e.g., if a modified webui.py also runs the bridge).
    """
    if not cmd_opts.nowebui:
        return

    import modules.scripts as mod_scripts

    # Guard: if setup_ui already ran (modified webui.py), skip
    for runner in [mod_scripts.scripts_txt2img, mod_scripts.scripts_img2img]:
        if runner and hasattr(runner, 'inputs') and len(runner.inputs) > 0:
            print("[Studio Bridge] ScriptRunner already initialized, skipping self-contained bridge")
            return

    try:
        # Load the gradio stub from alongside this script
        stub_path = os.path.join(os.path.dirname(__file__), "studio_gradio_stub.py")
        spec = importlib.util.spec_from_file_location("studio_gradio_stub", stub_path)
        stub_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stub_mod)

        install_stub = stub_mod.install_stub
        get_real_blocks = stub_mod.get_real_blocks

        install_stub()

        # Wrap setup_ui() in a real gr.Blocks() context — some extensions
        # (ADetailer, InputAccordion-based) use real Gradio components that
        # require a Blocks context for .change() calls during init.
        RealBlocks = get_real_blocks()

        for runner in [mod_scripts.scripts_txt2img, mod_scripts.scripts_img2img]:
            if runner:
                runner.prepare_ui()
                if RealBlocks:
                    blocks = RealBlocks()
                    blocks.__enter__()
                    try:
                        runner.setup_ui()

                        # Built-in scripts (Seed, Sampler, MaHiRo, RescaleCFG,
                        # Refiner) have non-None .section attributes. setup_ui()
                        # only calls setup_ui_for_section(None), which skips them.
                        # In Gradio mode, ui.py calls setup_ui_for_section for
                        # each section explicitly. We must do the same here or
                        # built-in scripts get args_from=None and receive the
                        # entire script_args array, causing type errors.
                        builtin_sections = set()
                        for s in runner.alwayson_scripts:
                            sec = getattr(s, 'section', None)
                            if sec is not None:
                                builtin_sections.add(sec)
                        for sec in sorted(builtin_sections):
                            runner.setup_ui_for_section(sec)

                    finally:
                        try:
                            blocks.__exit__(None, None, None)
                        except Exception:
                            pass  # Config serialization fails on stubs — fine
                else:
                    runner.setup_ui()
                    builtin_sections = set()
                    for s in runner.alwayson_scripts:
                        sec = getattr(s, 'section', None)
                        if sec is not None:
                            builtin_sections.add(sec)
                    for sec in sorted(builtin_sections):
                        runner.setup_ui_for_section(sec)

                n = len(runner.inputs) if hasattr(runner, 'inputs') else 0
                print(f"[Studio Bridge] {runner.__class__.__name__}: {n} inputs, "
                      f"{len(runner.alwayson_scripts)} alwayson, "
                      f"{len(runner.selectable_scripts)} selectable")

    except Exception as e:
        print(f"[Studio Bridge] Extension bridge init failed (non-fatal): {e}")
        import traceback
        traceback.print_exc()


# Register — fires in stock api_only_worker() before app_started_callback
script_callbacks.on_before_ui(_init_extension_bridge)
