@echo off
title Forge Studio (Low VRAM)
cd /d "%~dp0..\.."

set PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.9,max_split_size_mb:512
set COMMANDLINE_ARGS=--xformers --disable-sage --uv --cuda-malloc --fast-fp16 --nowebui --port 7860

echo =========================================================
echo  Forge Studio — Standalone Mode (Low VRAM)
echo  UI will be at: http://127.0.0.1:7860/studio
echo  By ToxicHost and Moritz
echo =========================================================

call webui.bat
