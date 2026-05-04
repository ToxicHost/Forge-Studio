@echo off
title Forge Studio
cd /d "%~dp0..\.."

set COMMANDLINE_ARGS=--xformers --sage --uv --pin-shared-memory --cuda-malloc --cuda-stream --fast-fp16 --nowebui --port 7860

echo =========================================================
echo  Forge Studio — Standalone Mode
echo  UI will be at: http://127.0.0.1:7860/studio
echo  By ToxicHost and Moritz
echo =========================================================

call webui.bat
