"""
Forge Studio v1.0
by ToxicHost & Moritz

Standalone tab with built-in multi-slot ADetailer, Hires Fix,
and generation preview.
"""

import gradio as gr
import modules.scripts as scripts
from modules import processing, shared, sd_samplers, sd_models, images
from modules.processing import StableDiffusionProcessingImg2Img, process_images, Processed
from modules.shared import opts, state
from PIL import Image
import numpy as np
import base64, io, os, json, random, traceback
from copy import copy

STUDIO_VERSION = "1.0"


def decode_b64(data_url):
    if not data_url or data_url in ("null", ""): return None
    if "," in data_url: data_url = data_url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data_url)))

def encode_b64(img, fmt="PNG"):
    buf = io.BytesIO(); img.save(buf, format=fmt)
    return f"data:image/{fmt.lower()};base64,{base64.b64encode(buf.getvalue()).decode()}"

def to_rgb(img):
    if img.mode == "RGBA":
        bg = Image.new("RGB", img.size, (255,255,255)); bg.paste(img, mask=img.split()[3]); return bg
    return img if img.mode == "RGB" else img.convert("RGB")


# =========================================================================
# STUDIO ADETAILER (multi-slot)
# =========================================================================

_ad_model_mapping = None

def get_ad_model_mapping():
    global _ad_model_mapping
    if _ad_model_mapping is not None:
        return _ad_model_mapping
    try:
        from adetailer.common import get_models as ad_get_models
        model_dir = os.path.join(getattr(shared, 'models_path', 'models'), 'adetailer')
        os.makedirs(model_dir, exist_ok=True)
        _ad_model_mapping = ad_get_models(model_dir)
        print(f"[Studio AD] Found {len(_ad_model_mapping)} models")
        return _ad_model_mapping
    except Exception as e:
        print(f"[Studio AD] Could not load model list: {e}")
        return {}

def get_ad_models():
    mapping = get_ad_model_mapping()
    return ["None"] + list(mapping.keys())


def run_adetailer_slot(image, model_name, confidence, denoise, mask_blur, inpaint_padding,
                       ad_prompt, ad_neg_prompt, p_orig):
    """Run a single ADetailer detection+inpaint pass."""
    if model_name == "None" or not image:
        return image
    try:
        if model_name.startswith("mediapipe"):
            from adetailer.mediapipe import mediapipe_predict
            pred = mediapipe_predict(model_name, image, confidence)
        else:
            from adetailer.ultralytics import ultralytics_predict
            mapping = get_ad_model_mapping()
            model_path = mapping.get(model_name, model_name)
            if model_path == "INVALID" or not os.path.exists(str(model_path)):
                print(f"[Studio AD] Model not found: {model_name}")
                return image
            device = ""
            if hasattr(shared, 'cmd_opts') and "adetailer" in getattr(shared.cmd_opts, 'use_cpu', []):
                device = "cpu"
            pred = ultralytics_predict(model_path, image, confidence, device=device)

        if not pred.bboxes or not pred.masks:
            print(f"[Studio AD] No detections with {model_name}")
            return image

        print(f"[Studio AD] Detected {len(pred.masks)} region(s) with {model_name}")
        result_image = image

        for j, mask in enumerate(pred.masks):
            mask_l = mask.convert("L") if mask.mode != "L" else mask
            if np.array(mask_l).max() < 10:
                continue

            prompt = ad_prompt if ad_prompt.strip() else p_orig.prompt
            neg = ad_neg_prompt if ad_neg_prompt.strip() else p_orig.negative_prompt

            # Clear stale interrupt flags before each inpaint region
            shared.state.interrupted = False
            shared.state.skipped = False

            p2 = StableDiffusionProcessingImg2Img(
                sd_model=shared.sd_model,
                outpath_samples=p_orig.outpath_samples, outpath_grids=p_orig.outpath_samples,
                prompt=prompt, negative_prompt=neg,
                init_images=[result_image], resize_mode=0,
                denoising_strength=denoise,
                mask_blur=mask_blur, inpainting_fill=1,
                inpaint_full_res=True, inpaint_full_res_padding=inpaint_padding,
                n_iter=1, batch_size=1, steps=p_orig.steps, cfg_scale=p_orig.cfg_scale,
                width=p_orig.width, height=p_orig.height,
                sampler_name=p_orig.sampler_name,
                seed=p_orig.seed + j if p_orig.seed != -1 else -1,
                do_not_save_samples=True, do_not_save_grid=True,
            )
            p2.image_mask = mask_l
            if hasattr(p_orig, 'scheduler'): p2.scheduler = p_orig.scheduler
            try:
                processed = process_images(p2)
                if processed and processed.images:
                    result_image = processed.images[0]
            except Exception as e:
                print(f"[Studio AD] Error on region {j}: {e}")
            finally:
                try: p2.close()
                except: pass
        return result_image
    except ImportError as e:
        print(f"[Studio AD] ADetailer models not available: {e}")
        return image
    except Exception as e:
        print(f"[Studio AD] Error: {e}")
        traceback.print_exc()
        return image


def run_adetailer_multi(image, slots, p_orig):
    """Run multiple ADetailer slots sequentially."""
    result = image
    for i, slot in enumerate(slots):
        if not slot.get("enable") or slot.get("model", "None") == "None":
            continue
        print(f"[Studio AD] Running slot {i+1}: {slot['model']}")
        result = run_adetailer_slot(
            result, slot["model"], slot["confidence"], slot["denoise"],
            slot["mask_blur"], slot["inpaint_pad"],
            slot.get("prompt", ""), slot.get("neg_prompt", ""), p_orig)
    return result


# =========================================================================
# STUDIO HIRES FIX
# =========================================================================

def get_upscalers():
    try:
        names = [x.name for x in shared.sd_upscalers if x.name != "None"]
        return names if names else ["Latent"]
    except:
        return ["Latent"]

def run_hires_fix(image, upscaler_name, scale, hr_steps, hr_denoise, hr_cfg, p_orig):
    if not image or scale <= 1.0:
        return image
    try:
        w, h = image.size
        new_w = (int(w * scale) // 8) * 8
        new_h = (int(h * scale) // 8) * 8
        upscaler = None
        for u in shared.sd_upscalers:
            if u.name == upscaler_name:
                upscaler = u; break
        if upscaler and upscaler.name != "None":
            print(f"[Studio HR] Upscaling {w}x{h} -> {new_w}x{new_h} with {upscaler_name}")
            upscaled = upscaler.scaler.upscale(image, scale, upscaler.data_path)
            if upscaled.size != (new_w, new_h):
                upscaled = upscaled.resize((new_w, new_h), Image.LANCZOS)
        else:
            upscaled = image.resize((new_w, new_h), Image.LANCZOS)
        use_steps = hr_steps if hr_steps > 0 else p_orig.steps
        use_cfg = hr_cfg if hr_cfg > 0 else p_orig.cfg_scale
        p2 = StableDiffusionProcessingImg2Img(
            sd_model=shared.sd_model,
            outpath_samples=p_orig.outpath_samples, outpath_grids=p_orig.outpath_samples,
            prompt=p_orig.prompt, negative_prompt=p_orig.negative_prompt,
            init_images=[upscaled], resize_mode=0, denoising_strength=hr_denoise,
            n_iter=1, batch_size=1, steps=use_steps, cfg_scale=use_cfg,
            width=new_w, height=new_h, sampler_name=p_orig.sampler_name,
            seed=p_orig.seed, do_not_save_samples=True, do_not_save_grid=True,
        )
        if hasattr(p_orig, 'scheduler'): p2.scheduler = p_orig.scheduler
        try:
            processed = process_images(p2)
            if processed and processed.images:
                print(f"[Studio HR] Hires pass complete: {new_w}x{new_h}")
                return processed.images[0]
        except Exception as e:
            print(f"[Studio HR] Second pass error: {e}")
        finally:
            try: p2.close()
            except: pass
        return upscaled
    except Exception as e:
        print(f"[Studio HR] Error: {e}")
        traceback.print_exc()
        return image


# =========================================================================
# INTERRUPT / SKIP
# =========================================================================

def do_interrupt():
    shared.state.interrupt()
    return "<p style='color:#fa0;'>Interrupted.</p>"

def do_skip():
    shared.state.skip()
    return "<p style='color:#6af;'>Skipping...</p>"


# =========================================================================
# MAIN GENERATION
# =========================================================================

def run_generation(
    canvas_b64, mask_b64, fg_b64, mode, inpaint_mode, prompt, neg_prompt,
    steps, sampler_name, schedule_type, cfg_scale, denoising,
    width, height, seed, batch_count, batch_size,
    mask_blur, inpainting_fill, inpaint_full_res, inpaint_pad,
    soft_inpaint_enabled, soft_inpaint_power, soft_inpaint_scale, soft_inpaint_detail,
    hr_enable, hr_upscaler, hr_scale, hr_steps, hr_denoise, hr_cfg,
    ad1_enable, ad1_model, ad1_confidence, ad1_denoise, ad1_mask_blur, ad1_inpaint_pad, ad1_prompt, ad1_neg_prompt,
    ad2_enable, ad2_model, ad2_confidence, ad2_denoise, ad2_mask_blur, ad2_inpaint_pad, ad2_prompt, ad2_neg_prompt,
    ad3_enable, ad3_model, ad3_confidence, ad3_denoise, ad3_mask_blur, ad3_inpaint_pad, ad3_prompt, ad3_neg_prompt,
):
    # === INTERRUPT FIX: Clear stale flags from previous runs ===
    shared.state.interrupted = False
    shared.state.skipped = False
    if hasattr(shared.state, 'stopping_generation'):
        shared.state.stopping_generation = False
    shared.state.job_count = -1

    # Load model if needed
    try:
        if shared.sd_model is None:
            try: sd_models.load_model()
            except AttributeError:
                try: sd_models.reload_model_weights()
                except: pass
    except: traceback.print_exc()

    if not canvas_b64 or canvas_b64 in ("null", ""):
        return [], "<p style='color:#f66;'>No canvas data.</p>", "", ""

    try:
        canvas_img = to_rgb(decode_b64(canvas_b64))
    except Exception as e:
        return [], f"<p>Canvas error: {e}</p>", "", ""

    w, h = int(width), int(height)
    canvas_img = canvas_img.resize((w, h), Image.LANCZOS)

    # === SEED FIX: randomize if -1 ===
    use_seed = int(seed)
    if use_seed == -1:
        use_seed = random.randint(0, 2**32 - 1)
        print(f"[Studio] Random seed: {use_seed}")

    # === STEPS: explicitly cast and log ===
    use_steps = int(steps)
    print(f"[Studio] Steps from UI: {use_steps}")

    mask_img, has_mask = None, False
    if mode == "Edit" and mask_b64 and mask_b64 not in ("null", ""):
        try:
            mask_img = decode_b64(mask_b64)
            if mask_img:
                mask_img = mask_img.resize((w, h), Image.LANCZOS).convert("L")
                # For Inpaint Sketch, dilate slightly for better coverage
                if inpaint_mode == "Inpaint Sketch":
                    from PIL import ImageFilter
                    short_side = min(w, h)
                    dil = int(0.015 * short_side) * 2 + 1
                    if dil > 1:
                        mask_img = mask_img.filter(ImageFilter.MaxFilter(dil))
                has_mask = np.array(mask_img).max() >= 10
                if has_mask:
                    # Binarize mask like Forge: point(lambda v: 255 if v > 128 else 0)
                    mask_img = mask_img.point(lambda v: 255 if v > 128 else 0)
                else:
                    mask_img = None
        except: traceback.print_exc()

    # === Separate output folders by mode ===
    base_outdir = os.path.dirname(
        opts.outdir_samples or opts.outdir_img2img_samples or "outputs/img2img-images"
    )
    mode_folder = {"Create": "create", "Edit": "edit", "img2img": "img2img"}.get(mode, "other")
    studio_outdir = os.path.join(base_outdir, "studio", mode_folder)
    os.makedirs(studio_outdir, exist_ok=True)

    # Build ADetailer slot configs
    ad_slots = []
    for en, mdl, conf, dn, mb, ip, pr, np_ in [
        (ad1_enable, ad1_model, ad1_confidence, ad1_denoise, ad1_mask_blur, ad1_inpaint_pad, ad1_prompt, ad1_neg_prompt),
        (ad2_enable, ad2_model, ad2_confidence, ad2_denoise, ad2_mask_blur, ad2_inpaint_pad, ad2_prompt, ad2_neg_prompt),
        (ad3_enable, ad3_model, ad3_confidence, ad3_denoise, ad3_mask_blur, ad3_inpaint_pad, ad3_prompt, ad3_neg_prompt),
    ]:
        ad_slots.append({
            "enable": en, "model": mdl or "None",
            "confidence": float(conf), "denoise": float(dn),
            "mask_blur": int(mb), "inpaint_pad": int(ip),
            "prompt": pr or "", "neg_prompt": np_ or "",
        })

    all_images, info_text = [], ""
    settings_json = ""

    try:
        for batch_idx in range(max(1, int(batch_count))):
            # Reset flags before each batch
            shared.state.interrupted = False
            shared.state.skipped = False

            batch_seed = use_seed + batch_idx

            p = StableDiffusionProcessingImg2Img(
                sd_model=shared.sd_model,
                outpath_samples=studio_outdir, outpath_grids=studio_outdir,
                prompt=prompt, negative_prompt=neg_prompt,
                init_images=[canvas_img], resize_mode=0,
                denoising_strength=float(denoising),
                n_iter=1, batch_size=max(1, int(batch_size)),
                steps=use_steps, cfg_scale=float(cfg_scale),
                width=w, height=h,
                sampler_name=sampler_name or "Euler a",
                seed=batch_seed,
                do_not_save_grid=True,
            )

            # === SAMPLER FIX: set scheduler before scripts, reassert after ===
            if schedule_type and schedule_type != "Automatic" and hasattr(p, 'scheduler'):
                p.scheduler = schedule_type
            p.sampler_name = sampler_name or "Euler a"

            if has_mask and mask_img:
                p.image_mask = mask_img
                p.mask_blur = int(mask_blur)
                p.inpainting_fill = int(inpainting_fill)
                p.inpaint_full_res = bool(inpaint_full_res)
                p.inpaint_full_res_padding = int(inpaint_pad)

            # Attach img2img script runner (wildcards, dynamic prompts, etc.)
            try:
                import modules.scripts as mod_scripts
                runner = mod_scripts.scripts_img2img
                if runner and hasattr(runner, 'alwayson_scripts'):
                    p.scripts = runner
                    n_inputs = len(runner.inputs) if hasattr(runner, 'inputs') else 0
                    script_args = [None] * n_inputs
                    if hasattr(runner, 'inputs') and runner.inputs:
                        for i, comp in enumerate(runner.inputs):
                            if comp is not None and hasattr(comp, 'value'):
                                script_args[i] = comp.value
                    if script_args:
                        script_args[0] = 0

                    # Inject Soft Inpainting settings
                    if has_mask and soft_inpaint_enabled:
                        for s in runner.alwayson_scripts:
                            if s.title() == "Soft Inpainting":
                                idx = s.args_from
                                if idx < len(script_args):
                                    script_args[idx] = True  # enabled
                                    if idx + 1 < len(script_args): script_args[idx + 1] = float(soft_inpaint_power)
                                    if idx + 2 < len(script_args): script_args[idx + 2] = float(soft_inpaint_scale)
                                    if idx + 3 < len(script_args): script_args[idx + 3] = float(soft_inpaint_detail)
                                    # Leave composite settings at defaults (mask_inf=0, dif_thresh=0.5, dif_contr=2)
                                    print(f"[Studio] Soft Inpainting enabled: power={soft_inpaint_power}, scale={soft_inpaint_scale}, detail={soft_inpaint_detail}")
                                break

                    p.script_args = tuple(script_args)
            except Exception as e:
                print(f"[Studio] Script runner attach failed: {e}")

            # === SAMPLER FIX: re-assert after script attachment ===
            p.sampler_name = sampler_name or "Euler a"
            if schedule_type and schedule_type != "Automatic" and hasattr(p, 'scheduler'):
                p.scheduler = schedule_type

            # === STEPS FIX: re-assert steps after script attachment ===
            p.steps = use_steps

            print(f"[Studio] Generating: sampler={p.sampler_name}, scheduler={getattr(p, 'scheduler', 'N/A')}, "
                  f"steps={p.steps}, seed={batch_seed}")

            processed = process_images(p)

            # Check interrupt AFTER processing
            if shared.state.interrupted:
                print("[Studio] Generation interrupted")
                if all_images:
                    break
                else:
                    return [], "<p style='color:#fa0;'>Generation interrupted.</p>", "", ""

            if shared.state.skipped:
                shared.state.skipped = False
                continue

            if not processed or not processed.images: continue

            for img in processed.images:
                result = img
                if hr_enable and float(hr_scale) > 1.0:
                    result = run_hires_fix(result, hr_upscaler, float(hr_scale),
                                          int(hr_steps), float(hr_denoise), float(hr_cfg), p)
                # Multi-slot ADetailer
                any_ad = any(s.get("enable") and s.get("model", "None") != "None" for s in ad_slots)
                if any_ad:
                    result = run_adetailer_multi(result, ad_slots, p)

                images.save_image(result, studio_outdir, "", p.seed, p.prompt,
                                  opts.samples_format, info=processed.info, p=p)
                all_images.append(result)
            if not info_text: info_text = processed.info or "Done."

            # Build settings JSON for transfer
            if not settings_json:
                settings_json = json.dumps({
                    "prompt": prompt,
                    "neg_prompt": neg_prompt,
                    "sampler": sampler_name,
                    "scheduler": schedule_type,
                    "steps": use_steps,
                    "cfg": float(cfg_scale),
                    "denoising": float(denoising),
                    "width": w, "height": h,
                    "seed": int(p.seed) if hasattr(p, 'seed') else use_seed,
                })

    except Exception as e:
        traceback.print_exc()
        return [], f"<p style='color:#f66;'>Error: {e}</p>", "", ""

    if all_images:
        return (all_images,
            f"<div style='font-size:11px;color:#aaa;max-height:200px;overflow-y:auto;'><pre style='white-space:pre-wrap;margin:0;'>{info_text}</pre></div>",
            encode_b64(all_images[0]),
            settings_json)
    return [], "<p>No images generated.</p>", "", ""


# =========================================================================
# UI
# =========================================================================

def on_ui_tabs():
    with gr.Blocks(analytics_enabled=False) as studio_tab:
        canvas_data = gr.Textbox(visible=False, elem_id="studio_canvas_data")
        mask_data = gr.Textbox(visible=False, elem_id="studio_mask_data")
        fg_data = gr.Textbox(visible=False, elem_id="studio_fg_data")
        result_data = gr.Textbox(visible=False, elem_id="studio_result_data")
        settings_data = gr.Textbox(visible=False, elem_id="studio_settings_data")

        with gr.Row(elem_id="studio_toprow"):
            with gr.Column(scale=6):
                prompt = gr.Textbox(label="Prompt", lines=3, elem_id="studio_prompt",
                    placeholder="Describe what to generate...")
                neg_prompt = gr.Textbox(label="Negative prompt", lines=2, elem_id="studio_neg_prompt")
            with gr.Column(scale=1, min_width=160):
                gen_btn = gr.Button("Generate", variant="primary", elem_id="studio_generate_btn", size="lg")
                with gr.Row():
                    interrupt_btn = gr.Button("Interrupt", variant="stop", elem_id="studio_interrupt_btn", size="sm")
                    skip_btn = gr.Button("Skip", variant="secondary", elem_id="studio_skip_btn", size="sm")

        with gr.Row(elem_id="studio_main_row"):
            with gr.Column(scale=4, elem_id="studio_left_col"):
                studio_mode = gr.Radio(choices=["Create","Edit","img2img"], value="Create",
                    label="Mode", elem_id="studio_mode_radio")

                # Inpaint sub-mode (Inpaint vs Inpaint Sketch)
                inpaint_mode = gr.Radio(choices=["Inpaint","Inpaint Sketch"], value="Inpaint",
                    label="Inpaint Mode", elem_id="studio_inpaint_mode", visible=False)
                studio_mode.change(fn=lambda m: gr.update(visible=m=="Edit"),
                    inputs=[studio_mode], outputs=[inpaint_mode])
                gr.HTML(value=_canvas_html(), elem_id="studio_canvas_block")

                with gr.Accordion("Edit Settings", open=False, elem_id="studio_inpaint_settings"):
                    mask_blur = gr.Slider(label="Mask blur", minimum=0, maximum=64, step=1, value=4)
                    inpaint_fill = gr.Dropdown(label="Masked content",
                        choices=["fill","original","latent noise","latent nothing"], value="original", type="index")
                    inpaint_full_res = gr.Radio(choices=["Whole picture","Only masked"],
                        value="Whole picture", label="Inpaint area", type="index")
                    inpaint_pad = gr.Slider(label="Only masked padding (px)", minimum=0, maximum=256, step=4, value=32)

                    gr.Markdown("---")
                    soft_inpaint_enabled = gr.Checkbox(label="Soft Inpainting", value=False,
                        info="Seamlessly blend original content with inpainted content using mask opacity. Recommended with high Mask blur values.")
                    with gr.Group(visible=False) as soft_inpaint_group:
                        soft_inpaint_power = gr.Slider(label="Schedule bias", minimum=0, maximum=8, step=0.1, value=1,
                            info="Shifts when preservation of original content occurs during denoising.")
                        soft_inpaint_scale = gr.Slider(label="Preservation strength", minimum=0, maximum=8, step=0.05, value=0.5,
                            info="How strongly partially masked content should be preserved.")
                        soft_inpaint_detail = gr.Slider(label="Transition contrast boost", minimum=1, maximum=32, step=0.5, value=4,
                            info="Amplifies the contrast that may be lost in partially masked regions.")
                    soft_inpaint_enabled.change(fn=lambda x: gr.update(visible=x),
                        inputs=[soft_inpaint_enabled], outputs=[soft_inpaint_group])

                with gr.Accordion("Hires Fix", open=False):
                    hr_enable = gr.Checkbox(label="Enable Hires Fix", value=False)
                    with gr.Row():
                        hr_upscaler = gr.Dropdown(label="Upscaler", choices=get_upscalers(),
                            value=get_upscalers()[0] if get_upscalers() else "Latent")
                        hr_scale = gr.Slider(label="Upscale by", minimum=1.0, maximum=4.0, step=0.05, value=2.0)
                    with gr.Row():
                        hr_steps = gr.Slider(label="Hires steps (0=same)", minimum=0, maximum=150, step=1, value=0)
                        hr_denoise = gr.Slider(label="Hires denoising", minimum=0, maximum=1, step=0.01, value=0.3)
                    hr_cfg = gr.Slider(label="Hires CFG (0=same)", minimum=0, maximum=30, step=0.5, value=0)

                with gr.Accordion("ADetailer", open=False):
                    with gr.Tab("Slot 1 (e.g. Face)"):
                        ad1_enable = gr.Checkbox(label="Enable", value=False)
                        with gr.Row():
                            ad1_model = gr.Dropdown(label="Model", choices=get_ad_models(), value="None")
                            ad1_confidence = gr.Slider(label="Confidence", minimum=0, maximum=1, step=0.01, value=0.3)
                        with gr.Row():
                            ad1_denoise = gr.Slider(label="Denoise", minimum=0, maximum=1, step=0.01, value=0.4)
                            ad1_mask_blur = gr.Slider(label="Mask blur", minimum=0, maximum=64, step=1, value=4)
                        ad1_inpaint_pad = gr.Slider(label="Inpaint padding", minimum=0, maximum=256, step=4, value=32)
                        ad1_prompt = gr.Textbox(label="Prompt (blank=main)", lines=1, value="")
                        ad1_neg_prompt = gr.Textbox(label="Neg prompt (blank=main)", lines=1, value="")
                    with gr.Tab("Slot 2"):
                        ad2_enable = gr.Checkbox(label="Enable", value=False)
                        with gr.Row():
                            ad2_model = gr.Dropdown(label="Model", choices=get_ad_models(), value="None")
                            ad2_confidence = gr.Slider(label="Confidence", minimum=0, maximum=1, step=0.01, value=0.3)
                        with gr.Row():
                            ad2_denoise = gr.Slider(label="Denoise", minimum=0, maximum=1, step=0.01, value=0.4)
                            ad2_mask_blur = gr.Slider(label="Mask blur", minimum=0, maximum=64, step=1, value=4)
                        ad2_inpaint_pad = gr.Slider(label="Inpaint padding", minimum=0, maximum=256, step=4, value=32)
                        ad2_prompt = gr.Textbox(label="Prompt (blank=main)", lines=1, value="")
                        ad2_neg_prompt = gr.Textbox(label="Neg prompt (blank=main)", lines=1, value="")
                    with gr.Tab("Slot 3"):
                        ad3_enable = gr.Checkbox(label="Enable", value=False)
                        with gr.Row():
                            ad3_model = gr.Dropdown(label="Model", choices=get_ad_models(), value="None")
                            ad3_confidence = gr.Slider(label="Confidence", minimum=0, maximum=1, step=0.01, value=0.3)
                        with gr.Row():
                            ad3_denoise = gr.Slider(label="Denoise", minimum=0, maximum=1, step=0.01, value=0.4)
                            ad3_mask_blur = gr.Slider(label="Mask blur", minimum=0, maximum=64, step=1, value=4)
                        ad3_inpaint_pad = gr.Slider(label="Inpaint padding", minimum=0, maximum=256, step=4, value=32)
                        ad3_prompt = gr.Textbox(label="Prompt (blank=main)", lines=1, value="")
                        ad3_neg_prompt = gr.Textbox(label="Neg prompt (blank=main)", lines=1, value="")

                with gr.Row():
                    sampler = gr.Dropdown(label="Sampling method",
                        choices=[s.name for s in sd_samplers.all_samplers], value="DPM++ 2M SDE",
                        elem_id="studio_sampler")
                    sched = gr.Dropdown(label="Schedule type",
                        choices=["Automatic","Uniform","Karras","Exponential","Polyexponential","SGM Uniform"],
                        value="Karras", elem_id="studio_scheduler")
                    steps = gr.Slider(label="Steps", minimum=1, maximum=150, step=1, value=20, elem_id="studio_steps")
                with gr.Row(elem_id="studio_size_row"):
                    s_w = gr.Slider(label="Width", minimum=64, maximum=2048, step=8, value=512, elem_id="studio_width")
                    s_h = gr.Slider(label="Height", minimum=64, maximum=2048, step=8, value=512, elem_id="studio_height")
                gr.HTML(value=_aspect_ratio_html(), elem_id="studio_ar_block")
                with gr.Row():
                    batch_n = gr.Slider(label="Batch count", minimum=1, maximum=16, step=1, value=1)
                    batch_s = gr.Slider(label="Batch size", minimum=1, maximum=8, step=1, value=1)
                cfg = gr.Slider(label="CFG Scale", minimum=1, maximum=30, step=0.5, value=7, elem_id="studio_cfg")
                denoise = gr.Slider(label="Denoising strength", minimum=0, maximum=1, step=0.01, value=0.75, elem_id="studio_denoise")
                with gr.Row():
                    seed = gr.Number(label="Seed", value=-1, precision=0, elem_id="studio_seed")
                    seed_reset = gr.Button("\U0001f3b2", elem_id="studio_seed_reset", size="sm", min_width=40)

                gr.HTML(f'<div style="text-align:center;color:#666;font-size:10px;padding:8px 0 4px;border-top:1px solid #374151;margin-top:8px;">Forge Studio v{STUDIO_VERSION} — by ToxicHost &amp; Moritz</div>')

            with gr.Column(scale=4, elem_id="studio_right_col"):
                preview_html = gr.HTML(value="", elem_id="studio_preview_area")
                gallery = gr.Gallery(label="Output", show_label=False, columns=2,
                    height="auto", elem_id="studio_gallery", object_fit="contain")
                info_html = gr.HTML(elem_id="studio_info")
                with gr.Row(elem_id="studio_output_actions"):
                    gr.Button("Result \u2192 Reference", elem_id="studio_result_to_ref", variant="secondary", size="sm")
                    gr.Button("Send to img2img", elem_id="studio_to_img2img", variant="secondary", size="sm")

        # Generation — inputs must match run_generation signature exactly
        gen_btn.click(fn=run_generation,
            inputs=[canvas_data, mask_data, fg_data, studio_mode, inpaint_mode,
                    prompt, neg_prompt, steps, sampler, sched, cfg, denoise,
                    s_w, s_h, seed, batch_n, batch_s,
                    mask_blur, inpaint_fill, inpaint_full_res, inpaint_pad,
                    soft_inpaint_enabled, soft_inpaint_power, soft_inpaint_scale, soft_inpaint_detail,
                    hr_enable, hr_upscaler, hr_scale, hr_steps, hr_denoise, hr_cfg,
                    ad1_enable, ad1_model, ad1_confidence, ad1_denoise, ad1_mask_blur, ad1_inpaint_pad, ad1_prompt, ad1_neg_prompt,
                    ad2_enable, ad2_model, ad2_confidence, ad2_denoise, ad2_mask_blur, ad2_inpaint_pad, ad2_prompt, ad2_neg_prompt,
                    ad3_enable, ad3_model, ad3_confidence, ad3_denoise, ad3_mask_blur, ad3_inpaint_pad, ad3_prompt, ad3_neg_prompt],
            outputs=[gallery, info_html, result_data, settings_data])

        # Interrupt / Skip
        interrupt_btn.click(fn=do_interrupt, outputs=[info_html])
        skip_btn.click(fn=do_skip, outputs=[info_html])

        # Seed reset
        seed_reset.click(fn=lambda: -1, outputs=[seed])

    return [(studio_tab, "Studio", "studio_tab")]


def _aspect_ratio_html():
    return """
<div id="studio-ar-container">
  <style>
    #studio-ar-container{padding:6px 0;}
    .sar-row{display:flex;flex-wrap:nowrap;gap:.36rem;overflow:hidden;margin-bottom:.36rem;}
    .sar-row>button{flex:1 1 0;min-width:0;}
    .sar-btn{
      border-radius:10px!important;overflow:hidden!important;background-clip:padding-box!important;
      padding:.5rem .8rem!important;font-weight:600;font-size:12px;
      border:1px solid transparent!important;cursor:pointer;
      box-shadow:0 2px 10px rgba(0,0,0,.15);white-space:nowrap;text-align:center;
      transition:all .15s;line-height:1.2;
    }
    .sar-btn:hover{filter:brightness(1.12);}
    .sar-base{background:var(--primary-500,#6C8CFF)!important;color:#fff!important;}
    .sar-base.active{background:#4f46e5!important;box-shadow:0 0 0 2px #818cf8,0 2px 10px rgba(0,0,0,.15)!important;}
    .sar-ratio{background:var(--button-secondary-background-fill,#374151);color:var(--button-secondary-text-color,#d1d5db);}
    .sar-ratio.active{background:var(--primary-500,#6C8CFF)!important;color:#fff!important;}
    .sar-orient{background:var(--button-secondary-background-fill,#374151);color:var(--button-secondary-text-color,#d1d5db);flex:0 0 auto!important;min-width:130px;}
    .sar-orient.portrait{background:#8b5cf6!important;color:#fff!important;}
    .sar-util{background:var(--button-secondary-background-fill,#374151);color:var(--button-secondary-text-color,#d1d5db);flex:0 0 auto!important;min-width:40px;}
    .sar-util.active{background:#ef4444!important;color:#fff!important;}
  </style>
  <div class="sar-row">
    <button class="sar-btn sar-base" data-base="512">512</button>
    <button class="sar-btn sar-base" data-base="640">640</button>
    <button class="sar-btn sar-base active" data-base="768">768</button>
    <button class="sar-btn sar-base" data-base="896">896</button>
    <button class="sar-btn sar-base" data-base="1024">1024</button>
    <button class="sar-btn sar-orient" id="studio-ar-orient">&harr; Landscape</button>
  </div>
  <div class="sar-row">
    <button class="sar-btn sar-ratio active" data-a="1" data-b="1">1:1</button>
    <button class="sar-btn sar-ratio" data-a="5" data-b="4">5:4</button>
    <button class="sar-btn sar-ratio" data-a="4" data-b="3">4:3</button>
    <button class="sar-btn sar-ratio" data-a="3" data-b="2">3:2</button>
    <button class="sar-btn sar-ratio" data-a="16" data-b="9">16:9</button>
    <button class="sar-btn sar-ratio" data-a="2" data-b="1">2:1</button>
    <button class="sar-btn sar-util" id="studio-ar-swap" title="Swap W&harr;H">&hArr;</button>
    <button class="sar-btn sar-util" id="studio-ar-lock" title="Lock current ratio">&#x1f513;</button>
  </div>
</div>
"""


def _canvas_html():
    return """
<div id="studio-container">
  <div id="studio-toolbar">
    <div class="stool-group" id="studio-tools-group">
      <button id="studio-tool-brush" class="stool active" title="Brush (B)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg></button>
      <button id="studio-tool-eraser" class="stool" title="Eraser (E)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 20H7L3 16l9-9 8 8-4 4z"/><path d="M6.5 13.5l5-5"/></svg></button>
      <button id="studio-tool-smudge" class="stool studio-sketch-only" title="Smudge (S)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 21c-2 0-3-1-3-3s3-6 6-9c3-3 6-5 8-5s3 1 3 3-3 6-6 9-6 5-8 5z"/></svg></button>
      <button id="studio-tool-blur" class="stool studio-sketch-only" title="Blur (R)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="10" stroke-dasharray="1 3"/></svg></button>
      <button id="studio-tool-fill" class="stool studio-sketch-only" title="Fill (G)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 21v-3l9-9 3 3-9 9H3z"/><path d="M14 6l3-3 3 3-3 3z"/></svg></button>
    </div>
    <span class="stool-sep"></span>
    <span class="stool-label">Size</span><input type="range" id="studio-brush-size" min="1" max="200" value="12" class="stool-range"><span id="studio-size-val" class="stool-val">12</span>
    <span class="stool-sep studio-sketch-only"></span>
    <span class="stool-label studio-sketch-only">Opacity</span><input type="range" id="studio-brush-opacity" min="1" max="100" value="100" class="stool-range studio-sketch-only"><span id="studio-opacity-val" class="stool-val studio-sketch-only">100%</span>
    <span class="stool-sep studio-sketch-only"></span>
    <span class="stool-label studio-sketch-only">Hardness</span><input type="range" id="studio-hardness" min="0" max="100" value="100" class="stool-range studio-sketch-only"><span id="studio-hardness-val" class="stool-val studio-sketch-only">100%</span>
    <span class="stool-sep studio-sketch-only"></span>
    <span class="stool-label studio-sketch-only">Smooth</span><input type="range" id="studio-smoothing" min="1" max="12" value="4" class="stool-range studio-sketch-only"><span id="studio-smooth-val" class="stool-val studio-sketch-only">4</span>
    <span class="stool-sep"></span>
    <span id="studio-strength-group" style="display:none;">
      <span class="stool-label">Strength</span><input type="range" id="studio-strength" min="10" max="100" value="50" class="stool-range"><span id="studio-strength-val" class="stool-val">50%</span>
      <span class="stool-sep"></span>
    </span>
    <input type="color" id="studio-color" value="#000000" class="stool-color studio-sketch-only" title="Color">
    <button id="studio-tool-eyedropper" class="stool studio-sketch-only" title="Eyedropper (I)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 21v-3l9-9 3 3-9 9H3z"/><circle cx="19" cy="5" r="3"/></svg></button>
    <div id="studio-swatches" class="studio-sketch-only">
      <span class="ssw" data-c="#000000" style="background:#000"></span><span class="ssw" data-c="#ffffff" style="background:#fff;outline:1px solid #555"></span>
      <span class="ssw" data-c="#ff0000" style="background:#f00"></span><span class="ssw" data-c="#00aa00" style="background:#0a0"></span>
      <span class="ssw" data-c="#0066ff" style="background:#06f"></span><span class="ssw" data-c="#ffaa00" style="background:#fa0"></span>
      <span class="ssw" data-c="#aa00ff" style="background:#a0f"></span><span class="ssw" data-c="#888888" style="background:#888"></span>
    </div>
  </div>
  <div id="studio-toolbar2">
    <span class="stool-label studio-sketch-only">Brush:</span>
    <div class="stool-group studio-sketch-only">
      <button class="stool-preset active" data-preset="round" title="Round">\u25cf</button>
      <button class="stool-preset" data-preset="flat" title="Flat">\u25ac</button>
      <button class="stool-preset" data-preset="scatter" title="Scatter">\u2726</button>
      <button class="stool-preset" data-preset="marker" title="Marker">\u25ae</button>
    </div>
    <span class="stool-sep studio-sketch-only"></span>
    <span class="stool-label studio-sketch-only">Mirror:</span>
    <div class="stool-group studio-sketch-only">
      <button class="stool-sym" data-sym="h" title="Horizontal">\u2194</button>
      <button class="stool-sym" data-sym="v" title="Vertical">\u2195</button>
      <button class="stool-sym" data-sym="both" title="Both">\u2725</button>
    </div>
    <span class="stool-sep studio-sketch-only"></span>
    <button id="studio-pressure-toggle" class="stool-toggle studio-sketch-only" title="Pen pressure on/off">\u270e</button>
    <div class="stool-group studio-sketch-only">
      <button class="stool-pmode active" data-pmode="both" title="Size+Opacity">S+O</button>
      <button class="stool-pmode" data-pmode="size" title="Size only">S</button>
      <button class="stool-pmode" data-pmode="opacity" title="Opacity only">O</button>
    </div>
    <span class="stool-sep studio-draw-only"></span>
    <span class="stool-label studio-layer-select">Layer:</span>
    <button id="studio-mode-sketch" class="stool-mode active studio-layer-select">Sketch</button>
    <button id="studio-mode-ref" class="stool-mode studio-layer-select">Reference</button>
    <button id="studio-mode-mask" class="stool-mode studio-layer-select">Inpaint</button>
    <span class="stool-sep studio-sketch-only"></span>
    <span class="stool-label studio-sketch-only">Recent:</span><div id="studio-color-history" class="stool-group studio-sketch-only"></div>
    <div style="margin-left:auto;display:flex;gap:3px;align-items:center;">
      <span id="studio-zoom-display" style="font-size:10px;color:#9ca3af;margin-right:4px;">100%</span>
      <button id="studio-zoom-fit" class="stool-action" title="Fit to view (F)">\u229e</button>
      <button id="studio-zoom-reset" class="stool-action" title="Reset zoom (0)">1:1</button>
      <span class="stool-sep"></span>
      <button id="studio-undo-btn" class="stool-action studio-draw-only" title="Undo (Ctrl+Z)">\u21b6</button>
      <button id="studio-redo-btn" class="stool-action studio-draw-only" title="Redo (Ctrl+Shift+Z)">\u21b7</button>
    </div>
  </div>
  <div id="studio-viewport"><canvas id="studio-canvas"></canvas></div>
  <div id="studio-layers">
    <div class="slayer studio-inpaint-layer" data-layer="mask"><button class="sl-eye" data-l="mask">\U0001f441</button><span class="sl-name">Inpaint</span></div>
    <div class="slayer studio-sketch-layer" data-layer="paint"><button class="sl-eye" data-l="paint">\U0001f441</button><span class="sl-name">Sketch</span></div>
    <div class="slayer-actions">
      <button id="studio-btn-clear" class="studio-draw-only" title="Clear active layer">\U0001f5d1 Clear Layer</button>
      <button id="studio-btn-clearall" class="studio-draw-only" title="Reset all layers">\U0001f5d1 Reset All</button>
      <button id="studio-btn-load">\U0001f4c2 Load Image</button>
    </div>
  </div>
</div>
<input type="file" id="studio-file-input" accept="image/*" style="display:none">
"""


scripts.script_callbacks.on_ui_tabs(on_ui_tabs)
