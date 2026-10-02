"""Populate the ignored project cache with metadata links to the pinned artifacts the delivery already acquired.

Some verification code (existing fast suites, and the reference revision used for the separate-process parity check)
resolves its inputs by the original Hub identifiers. That code must run offline against the same original bytes, and
the shared model store must stay a pure-storage destination: so instead of copying weights, this writes the Hub cache
layout the offline resolver looks for — `models--<org>--<name>/refs/<rev>` and `snapshots/<rev>` — where every file in
the snapshot is a symlink to the original artifact already on disk. Nothing is downloaded from the network.

    uv run --extra serve python scripts/refcache.py --link Qwen/Qwen3.5-0.8B-Base=<local dir>@<commit> \\
        --link jaredpalmer/kev-0.8b=<local dir>@<commit> [--cache <dir>] [--replace]

A link is refused when the target key already exists and points somewhere else, unless --replace says to relink it, and
the printed report records, per repository, whether it was created, kept, or relinked. No full weights are duplicated:
the snapshot holds only symlinks, and `du` on the cache stays negligible.
"""
import argparse
import json
import os
import sys
from pathlib import Path


def cache_root(explicit=None, env=os.environ):
    """The Hub cache directory to write into: the explicit path, else HF_HUB_CACHE, else HF_HOME/hub, else the default."""
    if explicit:
        return Path(explicit)
    if env.get("HF_HUB_CACHE"):
        return Path(env["HF_HUB_CACHE"])
    if env.get("HF_HOME"):
        return Path(env["HF_HOME"]) / "hub"
    return Path(env.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "huggingface" / "hub"


def repo_dir(cache, repo):
    return Path(cache) / ("models--" + repo.replace("/", "--"))


def parse_link(spec):
    """`repo=path@revision` -> (repo, path, revision). The revision is required: a floating branch is not a pin."""
    repo, _, rest = spec.partition("=")
    path, _, revision = rest.rpartition("@")
    if not (repo and path and revision):
        raise ValueError(f"--link needs the form repo=/path@revision, got {spec!r}")
    return repo, Path(path), revision


def write_ref(ref, revision, alias_main=False):
    """huggingface_hub reads refs/<revision> with a bare `f.read()` and does NOT strip it, so the commit goes in with no
    trailing newline: a newline here would make the cache miss and the offline resolver would try the network.
    `alias_main` also points the default `main` ref at this same pinned commit, which is what upstream-style test code
    that asks for a repository without a revision needs; the pinned commit stays the identity either way."""
    ref.write_text(revision, encoding="utf-8")
    if alias_main:
        (ref.parent / "main").write_text(revision, encoding="utf-8")


def link(cache, repo, target, revision, replace=False, alias_main=False):
    """-> ("created" | "kept" | "mismatch"). Idempotent: a snapshot that already points at these originals is left alone,
    and one that points elsewhere is reported unless --replace was given."""
    root = repo_dir(cache, repo)
    snapshot, ref = root / "snapshots" / revision, root / "refs" / revision
    wanted = {p.name: p.resolve() for p in payloads(target)}
    present = {p.name: p.resolve() for p in snapshot.iterdir() if p.is_file()} if snapshot.is_dir() else None
    if snapshot.exists() and present is None:
        raise ValueError(f"{snapshot} exists and is not a directory; refusing to touch it")
    if present == wanted:
        ref.write_text(revision, encoding="utf-8")   # refs/ can be missing after a manual cache move
        return "kept"
    if present is not None and not replace:
        return "mismatch"
    (root / "snapshots").mkdir(parents=True, exist_ok=True)
    (root / "refs").mkdir(parents=True, exist_ok=True)
    snapshot.mkdir(parents=True, exist_ok=True)
    for name, source in wanted.items():
        side = snapshot / name
        if side.is_symlink() or side.exists():
            side.unlink()
        side.symlink_to(source)
    for name in sorted(set(present or {}) - set(wanted)):
        (snapshot / name).unlink()
    write_ref(ref, revision, alias_main=alias_main)
    return "created" if present is None else "relinked"


def payloads(target):
    """The original payload files of an artifact: no dotfiles (no .gitattributes, no download cache)."""
    return sorted(p for p in Path(target).iterdir() if p.is_file() and not p.name.startswith("."))


def tree_cache(cache, repo, revision):
    """Write the Hub tree listing the offline resolver reads before it will use a snapshot: `snapshot_download` calls
    the /tree endpoint (and fails offline) unless it finds `trees/<commit>.json` in the cache. Built from the official
    metadata for that exact commit, so it is the same listing, not a hand-made one. -> file count."""
    from huggingface_hub import HfApi
    from huggingface_hub._tree_cache import TreeCacheEntry, write_tree_cache
    info = HfApi().model_info(repo, revision=revision, files_metadata=True)
    if info.sha != revision:
        raise ValueError(f"{repo}: the Hub now resolves {revision} to {info.sha}; refusing to cache a moved pin")
    entries = {}
    for sibling in info.siblings:
        lfs = getattr(sibling, "lfs", None)
        entries[sibling.rfilename] = TreeCacheEntry(size=sibling.size or 0,
                                                    blob_id=getattr(sibling, "blob_id", None) or (lfs.sha256 if lfs else "") or "",
                                                    lfs_sha256=lfs.sha256 if lfs else None,
                                                    lfs_size=lfs.size if lfs else None)
    write_tree_cache(str(repo_dir(cache, repo)), revision, entries)   # trees/ sits inside the repository directory
    return len(entries)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--link", action="append", default=[], metavar="repo=/path@revision")
    ap.add_argument("--cache", default=None, help="Hub cache root (default: HF_HUB_CACHE, HF_HOME/hub, or the user default)")
    ap.add_argument("--replace", action="store_true", help="relink a snapshot whose symlinks point elsewhere")
    ap.add_argument("--alias-main", action="store_true", help="also point the default `main` ref at the pinned commit")
    ap.add_argument("--tree-cache", action="store_true", help="also write the official tree listing for each pin")
    ap.add_argument("--report", default=None, help="write the per-repository report here as JSON")
    a = ap.parse_args(argv)
    cache = cache_root(a.cache)
    report = {}
    for spec in a.link:
        repo, target, revision = parse_link(spec)
        if not Path(target).is_dir():
            print(f"{repo}: {target} is not a directory", file=sys.stderr)
            return 2
        state = link(cache, repo, target, revision, replace=a.replace, alias_main=a.alias_main)
        report[repo] = {"revision": revision, "target": str(target), "snapshot": str(repo_dir(cache, repo) / "snapshots" / revision),
                        "state": state, "files": len(payloads(target)), "bytes": sum(p.stat().st_size for p in payloads(target))}
        print(f"{repo}@{revision[:12]}: {state} -> {report[repo]['snapshot']} ({report[repo]['files']} files, {report[repo]['bytes']} bytes)", flush=True)
        if state == "mismatch":
            print(f"  the existing snapshot points elsewhere; rerun with --replace to relink it", file=sys.stderr)
            return 3
        if a.tree_cache:
            report[repo]["tree_cache_files"] = tree_cache(cache, repo, revision)
            print(f"  tree cache: {report[repo]['tree_cache_files']} entries for {revision[:12]}", flush=True)
    if a.report:
        Path(a.report).write_text(json.dumps({"cache": str(cache), "links": report}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
