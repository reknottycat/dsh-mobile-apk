#!/usr/bin/env python3
"""inject-all.py — 快照注入单 pass 合并器（Phase 2c 结构性提速，2026-09-05）。

合并原三步链（每步各自全量解压+preset9 重压缩，~743MB tar × 3 遍）为**单 pass tar 流处理**：
  ① @dsh-android 命名空间注入（原 inject-snapshot.py：profiles/{web,headless}/node_modules/@dsh-android/<pkg>/）
  ② 根级插件注入（原 inject-external-plugins.py：undo/market 等非 scoped 包，lib/skills/清单文件）
  ③ cordis.patch.yml 权威装配覆盖（原 update-snapshot-patch.py：仅 web profile，--all-profiles 展开）
压缩从 ×4 → ×1、解压从 ×4 → ×1；发布档 preset 由 DSH_INJECT_PRESET 控制（默认 9 保发布保真，
-Fast dev 循环传 1 —— 743MB tar 上 preset9≈380s / preset1≈75s / 多线程 xz -6≈48s 实测，2026-09-05）。
并发上限（0.14.1 系统级约束）：构建期压缩/解压不得吃满全部逻辑核（原写法是 `-T0`），否则开发机被
撑满 → 同时运行的 MuMu 模拟器卡顿/系统不稳（「模拟器优先」是铁律 2）。统一走 scripts/lib/shell.mjs
的 XZ_THREADS（默认 8，可由 DSH_CPU_THREADS 覆写）；本文件自身不调 xz（只做 lzma 流式重打包）。

用法：
  python inject-all.py <snapshot.tar.xz> <out.tar.xz> <authoritative.patch.yml> --dsh-android <dir>... --external <dir>... [--all-profiles] [--browser-overlay <dir>]
字节级 tar 流替换，保留 symlink 元数据（Windows bsdtar 解包 symlink 需特权——tar 流处理不物化）。

装配 profile 覆盖（0.13.8-b ST-05 / F-ENV-02）：权威 patch 与注入包默认覆盖**全部**真实装配
profile（web + headless），不再只覆盖 web——见 PROFILES / NEGATIVE_CONTROL_PROFILES 的注释。
--all-profiles 为兼容保留的显式同义开关（历史上它是唯一开关且全仓无调用者）。
"""
import io
import hashlib
import json as _json
import lzma
import os
import re
import sys
import tarfile
from pathlib import Path

# 真实装配 profile（0.13.8-b ST-05 / F-ENV-02）：权威 patch 与注入包必须覆盖这里的每一个，
# 否则 profile 的 cordis.patch.yml 会永久停在旧值（历史实证：headless 的 bashPath 停在
# /data/user/0/<pkg>/usr（缺 /files 段）→ 启动 assertBash() 抛错、注入包全不装配，而门禁假绿）。
PROFILES = ("web", "headless")
# 负控夹具 profile：bashPath 刻意指向不存在路径（.../usr/bin/bash-not-exist），用于验证启动期
# 「坏配置拒绝」路径。构建链**不得**用权威 patch 覆盖它（覆盖即负控失效），门禁侧对它显式列白名单。
NEGATIVE_CONTROL_PROFILES = ("headless-bad",)
DSH_ANDROID_NS = "node_modules/@dsh-android/"
EXT_INCLUDE_FILES = ("package.json", "cordis.patch.yml", "spec.json", "README.md", "README.zh-CN.md", "LICENSE")
APP_BOOT = "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js"


def browser_member_path(name):
    """Canonical relative browser path; never allow an overlay outside this surface."""
    while name.startswith("./"):
        name = name[2:]
    if not name or name.startswith("/") or "\\" in name or ":" in name \
            or any(part in ("", ".", "..") for part in name.split("/")) \
            or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise ValueError("unsafe browser overlay member: " + repr(name))
    if not (re.search(r"(^|/)dsh-web-frontend/dist/.*\.js$", name)
            or re.search(r"(^|/)lib/client\.js$", name)):
        raise ValueError("browser overlay cannot replace a non-browser member: " + name)
    return name


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_browser_overlay(directory, archive):
    """Admit only the pinned source archive and byte-checked, regular staging files."""
    if directory is None:
        return {}
    root = Path(directory)
    manifest_path = root / "browser-overlay.json"
    if root.is_symlink() or not root.is_dir() or manifest_path.is_symlink():
        raise ValueError("browser overlay must be a real directory with a regular manifest")
    manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
    if type(manifest.get("version")) is not int or manifest["version"] != 1 \
            or manifest.get("target") != "chrome87" or manifest.get("esbuildVersion") != "0.25.12" \
            or not isinstance(manifest.get("files"), list):
        raise ValueError("unknown browser overlay manifest/toolchain")
    if manifest.get("archiveSha256") != sha256_file(archive):
        raise ValueError("browser overlay source archive SHA256 mismatch")
    result = {}
    for row in manifest["files"]:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str):
            raise ValueError("invalid browser overlay row")
        name = browser_member_path(row["path"])
        if name != row["path"] or name in result:
            raise ValueError("duplicate or noncanonical browser overlay path: " + name)
        for key in ("sourceSha256", "outputSha256"):
            if not isinstance(row.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", row[key]):
                raise ValueError("invalid browser overlay hash for " + name)
        file = root / "files"
        for part in name.split("/"):
            if file.is_symlink():
                raise ValueError("browser overlay paths may not traverse symlinks")
            file = file / part
        if file.is_symlink() or not file.is_file():
            raise ValueError("browser overlay data must be a regular file: " + name)
        data = file.read_bytes()
        if hashlib.sha256(data).hexdigest() != row["outputSha256"]:
            raise ValueError("browser overlay output SHA256 mismatch: " + name)
        result[name] = {"sourceSha256": row["sourceSha256"], "data": data}
    return result


def rebase_assembled_manifest(data, injected_names):
    """Preserve fail-loud ownership when a verified runtime receives local plugins."""
    pattern = re.compile(rb"(?m)^const DSH_MOBILE_ASSEMBLED_MANIFEST = (\{[^\r\n]*\});\r?$")
    matches = list(pattern.finditer(data))
    if len(matches) != 1:
        raise ValueError("app-boot G3 assembled manifest must have exactly one reviewed anchor")
    match = matches[0]
    manifest = _json.loads(match.group(1))
    names = manifest.get("names")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names) \
            or not isinstance(manifest.get("complete"), bool):
        raise ValueError("app-boot G3 assembled manifest shape changed")
    # Keep every original owner. Only packages actually injected by this build gain
    # product ownership; user-installed packages are never inferred from a prefix.
    manifest["names"] = sorted(set(names).union(injected_names))
    replacement = _json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    return data[:match.start(1)] + replacement + data[match.end(1):]


def parse_args(argv):
    if len(argv) < 4:
        print(__doc__)
        sys.exit(2)
    src, dst, patch_src = argv[1], argv[2], argv[3]
    dsh_dirs, ext_dirs, all_profiles, browser_overlay = [], [], False, None
    i = 4
    while i < len(argv):
        if argv[i] == "--dsh-android":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                dsh_dirs.append(argv[i]); i += 1
        elif argv[i] == "--external":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                ext_dirs.append(argv[i]); i += 1
        elif argv[i] == "--all-profiles":
            all_profiles = True; i += 1
        elif argv[i] == "--browser-overlay":
            if browser_overlay is not None or i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                raise ValueError("--browser-overlay requires exactly one directory")
            browser_overlay = argv[i + 1]; i += 2
        else:
            print("未知参数: " + argv[i]); sys.exit(2)
    return src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles, browser_overlay


def build_dsh_replacements(pkg_dirs):
    """@dsh-android 包名 -> {lib 相对路径 -> bytes} + package.json bytes"""
    out = {}
    for d in pkg_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, "lib")
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith(".map"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace("\\", "/")
                with open(full, "rb") as f:
                    files["lib/" + rel] = f.read()
        with open(os.path.join(d, "package.json"), "rb") as f:
            files["package.json"] = f.read()
        out[name] = files
    return out


def build_ext_replacements(pkg_dirs):
    """根级插件：真实包名（package.json name，可 scoped）-> {rel -> bytes}"""
    out = {}
    for d in pkg_dirs:
        try:
            with open(os.path.join(d, "package.json"), "rb") as f:
                name = _json.load(f)["name"]
        except Exception:
            name = os.path.basename(os.path.normpath(d))
        files = {}
        for sub in ("lib", "skills"):
            base = os.path.join(d, sub)
            if not os.path.isdir(base):
                continue
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    if fn.endswith(".map"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    with open(full, "rb") as f:
                        files[rel] = f.read()
        for fn in EXT_INCLUDE_FILES:
            full = os.path.join(d, fn)
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    files[fn] = f.read()
        if files:
            out[name] = files
    return out


def match_dsh_android(name, dsh_names):
    """命中返回 (pkg, rel)；lib/*(-.map) 与 package.json 可注入。"""
    parts = name.split("/")
    if len(parts) < 8 or parts[0:2] != ["home", ".dsh"]:
        return None
    if parts[2] != "profiles" or parts[3] not in PROFILES:
        return None
    if parts[4:6] != ["node_modules", "@dsh-android"]:
        return None
    pkg = parts[6]
    if pkg not in dsh_names:
        return None
    rel = "/".join(parts[7:])
    if rel.startswith("lib/"):
        return (pkg, rel) if not rel.endswith(".map") else None
    return (pkg, rel) if rel == "package.json" else None


def match_ext(name, ext_names):
    """命中返回 (pkg, rel)：lib/*(-.map) / skills/* / 清单文件。"""
    if not name.startswith("home/.dsh/profiles/"):
        return None
    for pkg in ext_names:
        marker = f"/node_modules/{pkg}/"
        idx = name.find(marker)
        if idx < 0:
            continue
        rel = name[idx + len(marker):]
        if rel.startswith("lib/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel.startswith("skills/"):
            return (pkg, rel)
        if rel in EXT_INCLUDE_FILES:
            return (pkg, rel)
    return None


def main():
    src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles, browser_overlay = parse_args(sys.argv)
    preset = int(os.environ.get("DSH_INJECT_PRESET", "9"))
    with open(patch_src, "rb") as f:
        patch_bytes = f.read()
    dsh_repl = build_dsh_replacements(dsh_dirs)
    ext_repl = build_ext_replacements(ext_dirs)
    browser_repl = load_browser_overlay(browser_overlay, src)
    dsh_names = set(dsh_repl.keys())
    ext_names = set(ext_repl.keys())
    injected_names = {
        _json.loads(files["package.json"])["name"]
        for files in list(dsh_repl.values()) + list(ext_repl.values())
    }
    # ST-05：权威 patch 与注入包的覆盖面 = 全部真实装配 profile（默认行为，不再只写 web）。
    target_profiles = list(PROFILES)
    print(f"inject-all: preset={preset} | assembly profiles: {target_profiles} "
          f"(negative-control, untouched: {list(NEGATIVE_CONTROL_PROFILES)}) | "
          f"@dsh-android: {sorted(dsh_names)} | external: {sorted(ext_names)}")
    if all_profiles:
        print("  --all-profiles: 全覆盖已是默认行为（该开关为兼容保留）")

    with lzma.open(src, "rb") as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    added_files = 0
    pruned = 0
    browser_seen = set()
    browser_applied = 0
    browser_superseded = 0
    # 逐 profile 记账：包名可能与某个 profile 已在场、另一个 profile 缺席
    # （历史实证：headless 只有 3 个 @dsh-android 包，web 已有 8 个——旧的全局 seen 集合
    #  让「web 有就等于全树有」，缺席的 profile 永远补不上）。
    seen_dsh = {}
    seen_ext = {}
    # P0（dev-incoming 实测 2026-09-12）：替换循环只命中「基座里已存在」的成员 → 包内**新增文件**
    # 被静默丢弃（包名已见 ⇒ 不触发整包追加），而 tar 内的 lib/index.js 仍 import 那些新文件
    # → 设备侧 ERR_MODULE_NOT_FOUND，引擎启动即死。修法：记录每个 (profile, 包) 在基座里见到的
    # rel 集合，循环结束后把该包**其余** rel 全部补 push（含 lib/types/**；.map 本就被排除）。
    seen_rels = {}
    seen_dirs = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:

        def mode_for(data):
            # 权限归一化（0.13.3）：快照源树在 WSL 9p 挂载上恒为 0777（chmod 无效），
            # 归档权限只能在重打包时按内容判定——ELF/shebang 可执行，其余数据文件不可执行。
            # Android 侧解压器同样按内容赋权，此处让归档本身可审计、可门禁校验。
            return 0o700 if data.startswith(b'\x7fELF') or data.startswith(b'#!') else 0o600

        def push(data, name, mtime):
            newm = tarfile.TarInfo(name)
            newm.size = len(data)
            newm.mtime = mtime
            newm.mode = mode_for(data)
            tout.addfile(newm, io.BytesIO(data))

        def factory_rel(name):
            """若成员位于某个注入包目录内 → (profile, pkg, rel)（含 .map 等不可注入文件）；否则 None。
            用于**修剪陈旧成员**：源包已删的文件不得留在快照里（0.13.7 去 fork 的旧组件就是这么残留的）。"""
            parts = name.split("/")
            if len(parts) < 7 or parts[0:2] != ["home", ".dsh"] or parts[2] != "profiles" \
                    or parts[3] not in PROFILES or parts[4] != "node_modules":
                return None
            if parts[5] == "@dsh-android":
                if len(parts) < 8 or parts[6] not in dsh_names:
                    return None
                return (parts[3], parts[6], "/".join(parts[7:]))
            if parts[5].startswith("@"):
                if len(parts) < 8:
                    return None
                scoped = parts[5] + "/" + parts[6]
                if scoped not in ext_names:
                    return None
                return (parts[3], scoped, "/".join(parts[7:]))
            if parts[5] not in ext_names:
                return None
            return (parts[3], parts[5], "/".join(parts[6:]))

        for member in tin:
            name = member.name
            # Original tar metadata is authoritative. Never turn a link into a
            # file, and validate even an overlay superseded by a local plugin.
            canonical_name = name
            while canonical_name.startswith("./"):
                canonical_name = canonical_name[2:]
            browser = browser_repl.get(canonical_name)
            if browser is not None:
                if canonical_name in browser_seen or not member.isfile():
                    raise ValueError("browser overlay target is duplicate or non-regular: " + name)
                browser_seen.add(canonical_name)
                if hashlib.sha256(tin.extractfile(member).read()).hexdigest() != browser["sourceSha256"]:
                    raise ValueError("browser overlay member source SHA256 mismatch: " + name)
            if member.isfile():
                data = None
                if name == APP_BOOT:
                    data = rebase_assembled_manifest(tin.extractfile(member).read(), injected_names)
                    push(data, name, int(member.mtime))
                    replaced += 1
                    print("  app-boot ownership aligned with injected plugins")
                    continue
                # 修剪：工厂包目录内、源包已不存在的成员一律丢弃（否则「注入后 == 源包」不成立）
                fr = factory_rel(name)
                if fr is not None:
                    fr_prof, fr_pkg, fr_rel = fr
                    fr_pool = dsh_repl if fr_pkg in dsh_names else ext_repl
                    if fr_rel not in fr_pool.get(fr_pkg, {}):
                        pruned += 1
                        if browser is not None:
                            browser_superseded += 1
                        if fr_pkg == "dsh-client-ui-responsive" or pruned <= 3:
                            print(f"  [prune] {fr_prof}: {fr_pkg}/{fr_rel}（源包已删）")
                        continue
                hit = match_dsh_android(name, dsh_names) or match_ext(name, ext_names)
                if hit is not None:
                    pkg, rel = hit
                    prof = name.split("/")[3]
                    pool = dsh_repl if (pkg in dsh_names and DSH_ANDROID_NS in name) else ext_repl
                    data = pool[pkg].get(rel)
                    # 无论是否替换，都把「基座里见到的该包 rel」记账：循环后据此补新增文件。
                    seen_rels.setdefault((prof, pkg), set()).add(rel)
                    if data is not None:
                        if browser is not None:
                            browser_superseded += 1
                        prof_seen = (seen_dsh if pkg in dsh_names else seen_ext)
                        prof_seen.setdefault(prof, set()).add(pkg)
                        push(data, name, int(member.mtime))
                        replaced += 1
                        continue
                if name.startswith("home/.dsh/profiles/") and name.endswith("/cordis.patch.yml") \
                        and "/node_modules/" not in name:
                    prof = name.split("/")[3]
                    if prof in target_profiles:
                        push(patch_bytes, name, int(member.mtime))
                        replaced += 1
                        print("  patch replaced:", name)
                        continue
                    print("  skip (not an assembly profile):", name)
                # Local plugin replacements and pruning above win over the old
                # archive's browser bytes. Only remaining base members use this
                # overlay; no second tar compression or whole-tree extraction.
                if browser is not None:
                    data = browser["data"]
                    browser_applied += 1
                    replaced += 1
                if data is None:
                    # 流式复制 + 只读前 4 字节判定权限（勿整文件读进内存：51k 文件 / 743MB 白花几分钟）
                    handle = tin.extractfile(member)
                    prefix = handle.read(4) if handle is not None else b''
                    if handle is not None:
                        handle.seek(0)
                    member.mode = mode_for(prefix)
                    tout.addfile(member, handle)
                else:
                    member.mode = mode_for(data)
                    member.size = len(data)
                    if "size" in member.pax_headers:
                        member.pax_headers["size"] = str(member.size)
                    tout.addfile(member, io.BytesIO(data))
            else:
                if member.isdir():
                    member.mode = 0o700
                    seen_dirs.add(name)
                # symlink/dir/hardlink：无内容，元数据原样复制
                tout.addfile(member)

        missing_browser = set(browser_repl) - browser_seen
        if missing_browser:
            raise ValueError("browser overlay targets absent from source archive: " + ", ".join(sorted(missing_browser)))

        # 追加模式：快照内不存在的包 → 落到**每一个**装配 profile（ST-05：只落 web 会让
        # headless 缺包，权威 patch 覆盖过去后 headless 装配失败；目录项一并生成）。
        # 可复现性（2026-09-08）：新增文件用固定 mtime（SOURCE_DATE_EPOCH 可覆写），
        # 否则同一输入的两次构建 sha256 不同 → 设备每次装机都判定「快照变了」重解压。
        now = int(os.environ.get("SOURCE_DATE_EPOCH", "1704067200"))

        def ensure_parent_dirs(path, mtime):
            """补齐新增文件的父目录项（缺失的才 add，避免重复目录条目）。path 为文件全名。"""
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i])
                if d in seen_dirs:
                    continue
                ti = tarfile.TarInfo(d)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o700
                ti.mtime = mtime
                tout.addfile(ti)
                seen_dirs.add(d)

        # 补缺：包已在基座里、但包内**新增文件**未出现在 tar 中 → 逐个补齐（P0 修复）。
        for (prof, pkg) in sorted(seen_rels):
            pool = dsh_repl if pkg in dsh_names else ext_repl
            if pkg not in pool:
                continue
            base = (f"home/.dsh/profiles/{prof}/node_modules/@dsh-android/{pkg}"
                    if pkg in dsh_names else f"home/.dsh/profiles/{prof}/node_modules/{pkg}")
            missing = [rel for rel in sorted(pool[pkg]) if rel not in seen_rels[(prof, pkg)]]
            if not missing:
                (seen_dsh if pkg in dsh_names else seen_ext).setdefault(prof, set()).add(pkg)
                continue
            for rel in missing:
                ensure_parent_dirs(base + "/" + rel, now)
                push(pool[pkg][rel], base + "/" + rel, now)
                added_files += 1
            (seen_dsh if pkg in dsh_names else seen_ext).setdefault(prof, set()).add(pkg)
            print(f"  [fill] {prof}: "
                  f"{'@dsh-android/' if pkg in dsh_names else ''}{pkg} 新增 {len(missing)} 文件 "
                  f"({', '.join(missing[:4])}{'…' if len(missing) > 4 else ''})")

        for prof in target_profiles:
            for pkg in sorted(dsh_names - seen_dsh.get(prof, set())):
                base = f"home/.dsh/profiles/{prof}/node_modules/@dsh-android/{pkg}"
                for dirpath in [base, base + "/lib"]:
                    ti = tarfile.TarInfo(dirpath)
                    ti.type = tarfile.DIRTYPE
                    ti.mode = 0o700
                    ti.mtime = now
                    tout.addfile(ti)
                for rel, data in sorted(dsh_repl[pkg].items()):
                    push(data, base + "/" + rel, now)
                    added_files += 1
                print(f"  [add] {prof}: @dsh-android/{pkg} ({len(dsh_repl[pkg])} files)")
            for pkg in sorted(ext_names - seen_ext.get(prof, set())):
                base = f"home/.dsh/profiles/{prof}/node_modules/{pkg}"
                for rel, data in sorted(ext_repl[pkg].items()):
                    push(data, base + "/" + rel, now)
                    added_files += 1
                print(f"  [add] {prof}: {pkg} ({len(ext_repl[pkg])} files)")

    with lzma.open(dst, "wb", preset=preset) as f:
        f.write(outbuf.getvalue())
    print(f"replaced entries: {replaced} | added files: {added_files} | pruned stale: {pruned} | preset={preset}")
    if browser_overlay is not None:
        print(f"browser overlay: applied={browser_applied} | superseded by local plugins={browser_superseded} | declared={len(browser_repl)}")
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
