#!/usr/bin/env python3
"""AKA-80 cargo metadata 依赖白名单守卫。

架构约束（ARCH-01 / ARCH-02 / ARCH-05）：
  • 三个底层 crate 互不依赖、禁止反向、禁止认识 Tauri / Arrow / HTTP。
  • app-core 是唯一映射层，可依赖三个底层。
  • src-tauri 顶层壳依赖 app-core + 全部底层 + Tauri。
  • indicator-golden 是 dev-only 夹具 crate，可自由依赖全部内部 crate。

外部依赖用 **允许清单**（allowlist），每个 crate 必须显式列出。

AKA-79 注册表计数断言也集成在本脚本末尾。

用法：
    cd app && python3 scripts/check-deps.py
    python3 scripts/check-deps.py --ci        # CI 模式：失败 exit 1
    python3 scripts/check-deps.py --dir ../   # 指定 workspace 根
    python3 scripts/check-deps.py --selftest  # AKA-30 反例自证：注入违规依赖必须被拦下
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple


# ── 每个 crate 的允许外部依赖清单 ────────────────────────────────────────

# indicator-core: 纯数值内核，只允许 serde
EXTERNAL_ALLOWLIST: Dict[str, Set[str]] = {
    "indicator-core": {"serde", "serde_json"},
    # data-provider: async trait 数据源，允许 async 基建 + 错误类型
    "data-provider": {"async-trait", "thiserror", "sha2", "serde", "serde_json"},
    # data-store: 持久化层，需要 SQLite + Parquet/Arrow（Sprint-5）
    # arrow 60 已拆分为 arrow-array / arrow-schema / arrow-buffer 三个包
    "data-store": {
        "rusqlite", "libsqlite3-sys", "serde", "serde_json", "thiserror",
        "arrow-array", "arrow-schema", "arrow-buffer", "parquet", "chrono", "csv",
    },
    # app-core: 编排层 —— ⚠️ rusqlite 为技术债（应通过 data-store），暂允许
    "app-core": {"serde", "serde_json", "libc", "rusqlite"},
    # indicator-golden: dev 夹具，允许任何
    "indicator-golden": None,  # None = 不检查
    # src-tauri: 顶层壳，允许所有
    "aka-desktop": None,  # None = 不检查
}

# 内部依赖方向（workspace crate 之间的允许边）
INTERNAL_ALLOWLIST: Dict[str, Set[str]] = {
    "indicator-core": set(),                    # 零内部
    "data-provider": set(),                     # 零内部
    "data-store": set(),                        # 零内部
    "app-core": {"indicator-core", "data-provider", "data-store"},
    "indicator-golden": {
        "indicator-core", "app-core", "data-provider", "data-store",
    },  # dev 夹具可依赖全部内部
    "aka-desktop": {"app-core", "indicator-core", "data-provider", "data-store"},
}

# 严禁出现的包（全局黑名单，所有 crate 都不能有）
GLOBAL_FORBIDDEN: Set[str] = {
    # HTTP：运行时零网络请求承诺（除 data-provider feature gate）
    "reqwest", "ureq", "surf", "hyper", "warp", "axum",
    # Tauri：只有 src-tauri 能依赖
    "tauri", "tauri-runtime", "tauri-utils", "tauri-build",
}
# data-store 专属的列式存储允许清单（Sprint-5 AKA-70/73 Parquet 持久化）
# 从 GLOBAL_FORBIDDEN 中移除后，其他 crate 仍禁止触碰，只有 data-store 的
# EXTERNAL_ALLOWLIST 显式放行。
DATASTORE_COLUMNAR_ALLOW: Set[str] = {
    "arrow-array", "arrow-schema", "arrow-buffer", "parquet",
}

# indicator-core 预期注册指标数（AKA-79）
PLANNED_COUNT = 105


# ── 工具函数 ────────────────────────────────────────────────────────────

def run(cmd: List[str], cwd: Path) -> Tuple[int, str, str]:
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=90
    )
    return proc.returncode, proc.stdout, proc.stderr


def load_metadata(workspace_dir: Path) -> dict:
    code, stdout, stderr = run(
        ["cargo", "metadata", "--format-version", "1", "--no-deps"],
        cwd=workspace_dir,
    )
    if code != 0:
        print(f"❌ cargo metadata 失败：\n{stderr}")
        sys.exit(2)
    return json.loads(stdout)


def parse_deps(metadata: dict) -> Tuple[Dict[str, Set[str]], Dict[str, Set[str]]]:
    """返回 (prod_deps, dev_deps)：每个 package 的生产/开发依赖集合。"""
    prod: Dict[str, Set[str]] = {}
    dev: Dict[str, Set[str]] = {}
    for pkg in metadata["packages"]:
        pname = pkg["name"]
        prod[pname] = set()
        dev[pname] = set()
        for dep in pkg.get("dependencies", []):
            kind = dep.get("kind", "normal")
            if kind == "dev":
                dev[pname].add(dep["name"])
            else:
                prod[pname].add(dep["name"])
    return prod, dev


def is_forbidden(dep: str) -> bool:
    """全局黑名单：精确匹配 + 子包前缀匹配。"""
    if dep in GLOBAL_FORBIDDEN:
        return True
    return any(dep.startswith(f"{f}-") for f in GLOBAL_FORBIDDEN)


# ── 注册表计数（AKA-79） ────────────────────────────────────────────────

def check_registry_count(workspace_dir: Path) -> Tuple[bool, str]:
    mod_rs = workspace_dir / "crates/indicator-core/src/indicators/mod.rs"
    if not mod_rs.exists():
        return False, f"缺少 {mod_rs}"

    content = mod_rs.read_text()

    if f"PLANNED_INDICATOR_COUNT: usize = {PLANNED_COUNT}" not in content:
        return False, f"PLANNED_INDICATOR_COUNT 应为 {PLANNED_COUNT}"

    m = re.search(r"static ALL: \[&dyn Indicator; (\d+)\]", content)
    if not m:
        return False, "未找到 static ALL 数组"

    actual = int(m.group(1))
    if actual == 0:
        return False, "ALL 数组为空"

    return True, f"已实现 {actual} / 规划 {PLANNED_COUNT}"


# ── 校验主体 ────────────────────────────────────────────────────────────

def validate(workspace_dir: Path, check_registry: bool = True) -> List[str]:
    """对一个 workspace 跑全部规则，返回错误列表（空 = 通过）。"""
    print(f"🔍 AKA 架构守卫扫描: {workspace_dir}\n")

    metadata = load_metadata(workspace_dir)
    prod_deps, _dev_deps = parse_deps(metadata)
    deps_map = prod_deps  # 规则检查只用生产依赖
    workspace_names = set(deps_map.keys())

    errors: List[str] = []

    # ── 规则 1：全局黑名单 ──
    print("━━━ 规则 1：全局禁令（HTTP / Tauri 在非顶层 crate 禁）━━━")
    print("    → Parquet/Arrow 已从黑名单移出，由 data-store 专属允许清单接管")
    for crate_name, deps in sorted(deps_map.items()):
        # 显式登记为 None = dev 夹具 / 顶层壳，跳过禁令
        if EXTERNAL_ALLOWLIST.get(crate_name, "unregistered") is None:
            print(f"  ✅ {crate_name}: 显式豁免（dev/顶层壳）")
            continue
        violations = sorted(d for d in deps if is_forbidden(d))
        if violations:
            errors.append(f"{crate_name}: 全局禁令 → {violations}")
            print(f"  ❌ {crate_name}: {', '.join(violations)}")
        else:
            print(f"  ✅ {crate_name}")

    # ── 规则 2：外部依赖允许清单 ──
    print("\n━━━ 规则 2：外部依赖允许清单 ━━━")
    unregistered = sorted(n for n in deps_map if n not in EXTERNAL_ALLOWLIST)
    if unregistered:
        errors.append(f"未登记的 workspace crate → {unregistered}")
        print(f"  ❌ 未登记（新增 crate 必须在允许清单显式登记）: {', '.join(unregistered)}")
    for crate_name, allowed in sorted(EXTERNAL_ALLOWLIST.items()):
        deps = deps_map.get(crate_name, set())
        external = sorted(d for d in deps if d not in workspace_names)

        if allowed is None:
            print(f"  ✅ {crate_name}: 不检查（dev/顶层壳）")
            continue

        violations = [d for d in external if d not in allowed]
        if violations:
            errors.append(f"{crate_name}: 外部依赖不在允许清单 → {violations}")
            print(f"  ❌ {crate_name}: 未允许的外部包 → {', '.join(violations)}")
        else:
            print(f"  ✅ {crate_name}: [{', '.join(external) or '无'}]")

    # ── 规则 3：内部依赖方向（单向） ──
    print("\n━━━ 规则 3：内部依赖方向 ━━━")
    for crate_name, allowed in sorted(INTERNAL_ALLOWLIST.items()):
        deps = deps_map.get(crate_name, set())
        internal = sorted(d for d in deps if d in workspace_names)
        violations = [d for d in internal if d not in allowed]
        if violations:
            errors.append(f"{crate_name}: 非法内部依赖 → {violations}")
            print(f"  ❌ {crate_name}: {', '.join(violations)}")
        else:
            print(f"  ✅ {crate_name} → [{', '.join(internal) or '无'}]")

    # ── 规则 4：注册表计数断言（AKA-79） ──
    if check_registry:
        print("\n━━━ 规则 4：注册表计数断言（AKA-79） ━━━")
        ok, msg = check_registry_count(workspace_dir)
        if ok:
            print(f"  ✅ {msg}")
        else:
            errors.append(f"注册表计数: {msg}")
            print(f"  ❌ {msg}")

    return errors


# ── 反例自证（AKA-30：白名单外依赖必须 fail） ────────────────────────────

def run_selftest() -> int:
    import shutil
    import tempfile

    root = Path(tempfile.mkdtemp(prefix="aka-deps-selftest-"))
    try:
        (root / "Cargo.toml").write_text(
            '[workspace]\nmembers = ["indicator-core", "evil"]\nresolver = "2"\n'
        )
        for name, deps in (
            ("indicator-core", 'serde = "1"\n'),
            ("evil", 'reqwest = "0.12"\n'),
        ):
            (root / name / "src").mkdir(parents=True)
            (root / name / "Cargo.toml").write_text(
                f'[package]\nname = "{name}"\nversion = "0.0.0"\nedition = "2021"\n\n'
                f"[dependencies]\n{deps}"
            )
            (root / name / "src" / "lib.rs").write_text("")

        joined = "\n".join(validate(root, check_registry=False))
        checks = [
            (
                "白名单外的 reqwest 必须命中全局禁令",
                "evil: 全局禁令" in joined and "reqwest" in joined,
            ),
            (
                "新增但未登记的 crate 必须报错",
                "未登记的 workspace crate" in joined and "evil" in joined,
            ),
            ("合规 crate 不得误报", "indicator-core:" not in joined),
        ]
        print("\n━━━ 反例自证（AKA-30）━━━")
        failed = 0
        for label, ok in checks:
            print(f"  {'✅' if ok else '❌'} {label}")
            if not ok:
                failed += 1
        return 0 if failed == 0 else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ── 主流程 ──────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="AKA cargo metadata 依赖白名单守卫")
    parser.add_argument("--dir", default=".", help="workspace 根目录")
    parser.add_argument("--ci", action="store_true", help="CI 模式：失败即非零退出")
    parser.add_argument(
        "--selftest", action="store_true", help="反例自证：注入违规依赖必须被拦下"
    )
    args = parser.parse_args()

    if args.selftest:
        return run_selftest()

    workspace_dir = Path(args.dir).resolve()
    if not (workspace_dir / "Cargo.toml").exists():
        print(f"❌ {workspace_dir} 不是 Cargo workspace")
        return 2

    errors = validate(workspace_dir)

    # ── 汇总 ──
    print()
    if errors:
        print(f"❌ 共 {len(errors)} 个违规：")
        for e in errors:
            print(f"  • {e}")
        return 1

    print("✅ 架构守卫全部通过！")
    return 0


if __name__ == "__main__":
    sys.exit(main())
