#!/usr/bin/env python3
"""Stage only regular browser members; the owning JS gate supplies its inventory regexes.

This helper never extracts tar links or modes. The final injector retains their
original metadata, so Windows staging does not need symlink privileges.
"""
import hashlib
import json
import os
import posixpath
import re
import sys
import tarfile
from pathlib import Path


def safe_member(name):
    while name.startswith("./"):
        name = name[2:]
    if not name or name.startswith("/") or "\\" in name or ":" in name \
            or any(part in ("", ".", "..") for part in name.split("/")) \
            or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError("unsafe browser archive member: " + repr(name))
    return name


def stage(archive, destination, inventory):
    patterns = [(item["kind"], re.compile(item["source"])) for item in inventory]
    output = Path(destination)
    if output.is_symlink() or output.exists() and any(output.iterdir()):
        raise ValueError("browser staging destination must be empty and not a symlink")
    output.mkdir(parents=True, exist_ok=True)
    files, links, seen = [], [], set()
    with tarfile.open(archive, mode="r|*") as source:
        for member in source:
            kind = next((kind for kind, pattern in patterns if pattern.search(member.name)), None)
            if kind is None:
                continue
            name = safe_member(member.name)
            if name in seen:
                raise ValueError("duplicate browser archive member: " + name)
            seen.add(name)
            if member.isfile():
                data = source.extractfile(member).read()
                path = output.joinpath(*name.split("/"))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                files.append({"path": name, "kind": kind, "sourceSha256": hashlib.sha256(data).hexdigest()})
            elif member.issym() or member.islnk():
                target = member.linkname if member.islnk() else posixpath.join(posixpath.dirname(name), member.linkname)
                # Resolve relative links only inside the same browser inventory.
                # Their metadata stays in the source tar, never the staging tree.
                target = safe_member(posixpath.normpath(target))
                links.append({"path": name, "target": target, "kind": kind})
            else:
                raise ValueError("browser member is not a file or a file link: " + name)
    regular = {item["path"] for item in files}
    targets = {item["path"]: item["target"] for item in links}
    for link in links:
        target, visited = link["target"], {link["path"]}
        while target not in regular:
            if target in visited or target not in targets:
                raise ValueError("browser link has no regular target in the inventory: " + link["path"])
            visited.add(target)
            target = targets[target]
    return {"files": files, "links": links}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: browser-syntax-archive.py <archive> <empty-stage-dir>; inventory JSON on stdin")
    print(json.dumps(stage(sys.argv[1], sys.argv[2], json.load(sys.stdin)), separators=(",", ":")))
