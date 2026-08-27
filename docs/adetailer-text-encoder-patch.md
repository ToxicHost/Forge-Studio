# ADetailer patch: detail-pass text encoder

Studio can run the ADetailer detail pass on a different checkpoint than the
main generation. On its own that is only safe **within one architecture**.

Forge keeps the text encoder in `forge_additional_modules`, and a checkpoint
override rewrites `sd_model_checkpoint` and nothing else:

```python
# modules_forge/main_entry.py — refresh_model_loading_parameters()
model_data.forge_loading_parameters = dict(
    checkpoint_info=checkpoint_info,
    additional_modules=shared.opts.forge_additional_modules,   # carried over
    unet_storage_dtype=unet_storage_dtype)
```

Override an SDXL generation to an Anima checkpoint and Anima loads against
SDXL's module set — with no Qwen3 encoder. Forge builds the model under
`no_init_weights()`, so the missing tensors keep whatever was in that memory
and the pass paints noise rather than failing.

Stock ADetailer can't carry the fix. It builds its override dict from scratch
and never reads the parent's, so nothing Studio sets from outside reaches it:

```python
# scripts/!adetailer.py
def get_override_settings(self, _p, args: ADetailerArgs) -> dict[str, Any]:
    d = {}
    if args.ad_use_clip_skip: ...
    if args.ad_use_checkpoint and ...: d["sd_model_checkpoint"] = args.ad_checkpoint
    if args.ad_use_vae and ...:        d["sd_vae"] = args.ad_vae
    return d
```

`forge_additional_modules` is a first-class `set_config` override key
(`modules/sysinfo.py`), same tier as `sd_model_checkpoint`, so the fix is just
letting the value through.

Without this patch Studio disables the control and refuses cross-architecture
checkpoint overrides. Nothing else changes.

## The patch

Against `26.2.0-studio.1`. Two hunks.

**1. `adetailer/args.py`** — declare the fields (`extra="forbid"` rejects
anything undeclared, and ADetailer treats the resulting validation error as
"slot disabled", so this must land before Studio sends them):

```diff
     ad_clip_skip: conint(ge=1, le=12) = 1
+    ad_use_modules: bool = False
+    ad_modules: list[str] = []
     ad_restore_face: bool = False
```

**2. `scripts/!adetailer.py`**, in `get_override_settings`:

```diff
         if (
             args.ad_use_vae
             and args.ad_vae
             and args.ad_vae not in ("None", "Use same VAE")
         ):
             d["sd_vae"] = args.ad_vae
+
+        if args.ad_use_modules and args.ad_modules:
+            d["forge_additional_modules"] = list(args.ad_modules)
         return d
```

That's all. Studio sends the complete replacement list, so ADetailer doesn't
need to know which entry is an encoder and which is a VAE.

## Why the whole list, not just the encoder

`forge_additional_modules` holds the encoder *and* the VAE. Sending only the
encoder would drop the VAE with it. Studio composes the full list
(`_resolve_ad_modules`), carrying the loaded VAE across unless the slot names
its own, and resolves names to full paths — Forge's `modules_change()` matches
on basename against its own registry and silently skips anything it doesn't
recognise.

When the module override is active Studio also turns `ad_use_vae` off and
folds the VAE into the list, so the two mechanisms never write the same slot
twice. Forge applies `forge_additional_modules` first and then re-reads opts
for the `sd_vae` path, so the ordering is safe either way; this keeps it
unambiguous.

## Verifying

`/studio/ad_capabilities` reports `text_encoder: true` once both fields are
declared, and the control enables itself. Before the patch it reports false
and the control stays disabled.

With overrides engaged, each pass logs what it sent:

```
[Studio AD] Slot 1 overrides: checkpoint='anima_baseV10 [bd43b7cffe]', text_encoder=...
```

If ADetailer stops running entirely after enabling an override, that is the
`extra="forbid"` path — a field arrived that the installed build doesn't
declare, and it is treating every slot as disabled. Compare the logged keys
against `ADetailerArgs`.
