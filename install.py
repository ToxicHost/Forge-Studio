# Forge Studio — install.py

import launch

# Gallery module: video thumbnail extraction via ffmpeg
if not launch.is_installed("imageio-ffmpeg"):
    launch.run_pip("install imageio-ffmpeg", "imageio-ffmpeg (Gallery video thumbnails)")

# Gallery module: perceptual hashing for duplicate detection
if not launch.is_installed("imagehash"):
    launch.run_pip("install imagehash", "imagehash (Gallery duplicate detection)")
