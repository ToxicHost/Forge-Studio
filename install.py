# Forge Studio — install.py

import launch

# Gallery module: video thumbnail extraction via ffmpeg
if not launch.is_installed("imageio-ffmpeg"):
    launch.run_pip("install imageio-ffmpeg", "imageio-ffmpeg (Gallery video thumbnails)")
