"""Deterministic JSON output under studenttrustee/data/legislation/.

Files are written with sorted keys and compact separators so that a nightly
run with no upstream changes produces no diff. write_json only touches the
file when the content differs.
"""
import json
import os

from .common import DATA_DIR


def path(rel):
    return os.path.join(DATA_DIR, rel)


def read_json(rel, default=None):
    try:
        with open(path(rel), encoding='utf-8') as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return default


def write_json(rel, obj, pretty=False):
    p = path(rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if pretty:
        text = json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + '\n'
    else:
        text = json.dumps(obj, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n'
    try:
        with open(p, encoding='utf-8') as fh:
            if fh.read() == text:
                return False
    except FileNotFoundError:
        pass
    with open(p, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    return True


def remove_stale(rel_dir, keep):
    """Delete files in rel_dir whose basename is not in keep (a set of basenames)."""
    d = path(rel_dir)
    if not os.path.isdir(d):
        return 0
    n = 0
    for name in os.listdir(d):
        if name not in keep and os.path.isfile(os.path.join(d, name)):
            os.remove(os.path.join(d, name))
            n += 1
    return n
