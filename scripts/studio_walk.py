"""Forge Studio — shared directory-walk helper.

Studio's scanners (gallery, wildcards, LoRA/checkpoint listings) all walk
directory trees with os.walk, whose default followlinks=False silently
skips symlinked directories: symlinked *files* list fine, symlinked
*directories* vanish. (Windows junctions were never affected — Python does
not classify them as links, so bare os.walk already descends them.)

walk_follow() is the one shared fix: os.walk(followlinks=True) behind a
realpath cycle guard, so link cycles terminate and a directory reachable
through two paths is listed only once.

Deliberately NOT used by the count-before-delete walks: shutil.rmtree does
not follow directory symlinks, so a follow-links count there would report
more files than the delete actually removes.
"""

import os


def walk_follow(root):
    """os.walk(root, followlinks=True) yielding every real directory once.

    A set of os.path.realpath(dirpath) guards against symlink cycles and
    double-listing: arriving at a directory whose real path was already
    visited (a cycle, or a second link to the same target) descends no
    further and yields nothing for it.

    Yields the same (dirpath, dirnames, filenames) tuples as os.walk, and
    the dirnames list is os.walk's own — in-loop pruning/sorting by the
    caller still steers the traversal exactly as with bare os.walk.
    """
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in seen:
            del dirnames[:]  # already walked via another path
            continue
        seen.add(real)
        yield dirpath, dirnames, filenames
