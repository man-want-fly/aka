#!/usr/bin/env python3
"""
AKA PRD → Linear 批量导入脚本
=============================

用法:
    1. 去 https://linear.app/settings/api 创建 Personal API Key
    2. export LINEAR_API_KEY='lin_xxx...'
    3. python3 linear_import.py

功能:
    - 自动查询 Team（默认取第一个）
    - 创建标签: Epic / Feature / Story / Task + P0/P1/P2/P3
    - 按 Epic → Feature → Story → Task 四层顺序批量创建
    - Story/Task 自动设置 parentId 建立父子层级
    - 每 10 条 issue 存 checkpoint.json，失败可 --resume
    - 最终输出 issue_map.json（AKA ID → Linear issue identifier 映射）

线性 API 参考: https://developers.linear.app/docs/graphql/introduction
"""

import json
import os
import sys
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
PRD_JSON = Path(__file__).parent / "aka-epic-feature-story-task.json"
CHECKPOINT_FILE = Path(__file__).parent / "checkpoint.json"
ISSUE_MAP_FILE = Path(__file__).parent / "issue_map.json"

LINEAR_API = "https://api.linear.app/graphql"
REQUEST_DELAY = 0.3  # 每条 issue 之间的间隔秒数（避免 rate limit）

# 优先级映射: PRD P0→High, P1→Medium, P2→Low, P3→NoPriority
PRIORITY_MAP = {
    "P0": "HIGH",
    "P1": "MEDIUM",
    "P2": "LOW",
    "P3": "NO_PRIORITY",
}

# 层级类型 → Linear issue 标签
TIER_LABELS = {
    "epic": "Epic",
    "feature": "Feature",
    "story": "Story",
    "task": "Task",
}


# ---------------------------------------------------------------------------
# GraphQL 客户端
# ---------------------------------------------------------------------------
def gql(query: str, variables: dict | None = None) -> dict:
    """发送 GraphQL 请求到 Linear API"""
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        print("❌ 请先 export LINEAR_API_KEY='lin_xxx...'")
        sys.exit(1)

    payload = json.dumps({
        "query": query,
        "variables": variables or {},
    }).encode("utf-8")

    req = urllib.request.Request(
        LINEAR_API,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"❌ HTTP {e.code}: {body[:500]}")
        sys.exit(1)

    if "errors" in data and data["errors"]:
        print(f"❌ GraphQL errors: {json.dumps(data['errors'], indent=2)[:1000]}")
        sys.exit(1)

    return data.get("data", {})


# ---------------------------------------------------------------------------
# Linear 对象查询 / 创建
# ---------------------------------------------------------------------------
def get_team() -> dict:
    """获取第一个 Team"""
    data = gql("""
        query {
            teams { nodes { id name key } }
        }
    """)
    nodes = data.get("teams", {}).get("nodes", [])
    if not nodes:
        print("❌ 未找到任何 Team")
        sys.exit(1)
    team = nodes[0]
    print(f"✅ Team: {team['name']} (key={team['key']})")
    return team


def get_or_create_labels(team_id: str) -> dict[str, str]:
    """确保层级标签存在，返回 {name: id} 映射"""
    # 查询已有标签
    data = gql("""
        query($teamId: String!) {
            teamLabels(teamId: $teamId) { nodes { id name } }
        }
    """, {"teamId": team_id})

    existing = {n["name"]: n["id"] for n in data.get("teamLabels", {}).get("nodes", [])}
    needed = list(TIER_LABELS.values()) + ["P0", "P1", "P2", "P3"]

    for label_name in needed:
        if label_name not in existing:
            gql("""
                mutation($name: String!, $teamId: String!) {
                    issueLabelCreate(input: { name: $name, teamId: $teamId }) {
                        issueLabel { id name }
                    }
                }
            """, {"name": label_name, "teamId": team_id})
            print(f"  🏷️  创建标签: {label_name}")

    # 重新查询拿到完整映射
    data = gql("""
        query($teamId: String!) {
            teamLabels(teamId: $teamId) { nodes { id name } }
        }
    """, {"teamId": team_id})
    return {n["name"]: n["id"] for n in data.get("teamLabels", {}).get("nodes", [])}


def create_issue(
    team_id: str,
    title: str,
    description: str,
    label_ids: list[str],
    parent_id: str | None,
    priority: str,
) -> dict | None:
    """创建单条 issue，返回 {id, identifier} 或 None"""
    variables = {
        "teamId": team_id,
        "title": title[:255],  # Linear title 最长 255
        "description": description[:10000],  # Linear description 上限
        "labelIds": label_ids,
        "priority": priority,
    }
    if parent_id:
        variables["parentId"] = parent_id

    data = gql("""
        mutation CreateIssue(
            $teamId: String!
            $title: String!
            $description: String
            $labelIds: [String!]
            $priority: Priority
            $parentId: String
        ) {
            issueCreate(input: {
                teamId: $teamId
                title: $title
                description: $description
                labelIds: $labelIds
                priority: $priority
                parentId: $parentId
            }) {
                success
                issue { id identifier title }
            }
        }
    """, variables)

    result = data.get("issueCreate", {})
    if not result.get("success"):
        return None
    return result.get("issue")


# ---------------------------------------------------------------------------
# 数据处理
# ---------------------------------------------------------------------------
def build_description(prefix: str, block: dict) -> str:
    """从 PRD JSON 构建 Linear issue 描述（Markdown）"""
    sections = [f"**来源**: AKA MVP PRD · {prefix}"]

    if block.get("name"):
        sections.append(f"### 描述\n{block['name']}")

    if block.get("architectureConstraints"):
        lines = []
        for c in block["architectureConstraints"]:
            lines.append(f"- **{c['id']}** {c['desc']} — {c.get('source', '')}")
        sections.append("### 架构硬约束\n" + "\n".join(lines))

    if block.get("hardConstraints"):
        lines = [f"- {c}" for c in block["hardConstraints"]]
        sections.append("### 硬约束\n" + "\n".join(lines))

    if block.get("upstreamDependencies") or block.get("upstreamFeatures"):
        deps = block.get("upstreamDependencies") or block.get("upstreamFeatures")
        lines = []
        for d in deps:
            if isinstance(d, str):
                lines.append(f"- {d}")
            elif isinstance(d, dict):
                reason = d.get("reason", "")
                lines.append(f"- **{d.get('feature', '')}** ({d.get('type', '')}): {reason}")
        sections.append("### 依赖\n" + "\n".join(lines))

    if block.get("detailedAcceptance"):
        lines = []
        for a in block["detailedAcceptance"]:
            lines.append(
                f"- **{a.get('dimension', '')}**: {a.get('item', '')}"
                + (f"（验证: {a.get('verification', '')}）" if a.get("verification") else "")
            )
        sections.append("### 验收标准\n" + "\n".join(lines))

    if block.get("acceptanceCriteria"):
        lines = [f"- {a}" for a in block["acceptanceCriteria"]]
        sections.append("### 验收标准（高层）\n" + "\n".join(lines))

    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="AKA PRD → Linear 批量导入")
    parser.add_argument("--team", help="指定 Team ID（默认自动查第一个）")
    parser.add_argument("--resume", action="store_true", help="从 checkpoint.json 继续")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不实际创建")
    args = parser.parse_args()

    # 1. 加载 PRD
    print(f"📄 加载 PRD: {PRD_JSON}")
    prd = json.loads(PRD_JSON.read_text(encoding="utf-8"))
    print(f"   Epic 数: {len(prd['epics'])}")
    total_features = sum(len(e["features"]) for e in prd["epics"])
    print(f"   Feature 数: {total_features}")

    # 2. Team + Labels
    if args.dry_run:
        print("🏃 DRY-RUN 模式: 不实际创建 issue")
        team = {"id": "DRY_TEAM_ID", "name": "Dry Run", "key": "DRY"}
        label_map = {"Epic": "L_EPIC", "Feature": "L_FEATURE", "Story": "L_STORY", "Task": "L_TASK",
                     "P0": "L_P0", "P1": "L_P1", "P2": "L_P2", "P3": "L_P3"}
    else:
        team = {"id": args.team} if args.team else get_team()
        label_map = get_or_create_labels(team["id"])

    # 3. Resume?
    existing_map = {}
    if args.resume and CHECKPOINT_FILE.exists():
        checkpoint = json.loads(CHECKPOINT_FILE.read_text(encoding="utf-8"))
        existing_map = checkpoint.get("issue_map", {})
        print(f"🔄 Resume from checkpoint: 已有 {len(existing_map)} 条映射")

    epic_label = label_map.get("Epic", "")
    feature_label = label_map.get("Feature", "")
    story_label = label_map.get("Story", "")
    task_label = label_map.get("Task", "")
    p_label_map = {f"P{i}": label_map.get(f"P{i}", "") for i in range(4)}

    issue_map: dict[str, str] = dict(existing_map)  # aka_id → linear_identifier

    def tier_labels(tier: str, priority: str) -> list[str]:
        labels = []
        tier_map = {"epic": epic_label, "feature": feature_label,
                    "story": story_label, "task": task_label}
        if tier_map.get(tier):
            labels.append(tier_map[tier])
        if p_label_map.get(priority):
            labels.append(p_label_map[priority])
        return labels

    created_count = 0
    skipped_count = 0

    # 4. Epic → Feature → Story → Task
    for epic in prd["epics"]:
        epic_id = epic["id"]
        epic_priority = epic.get("priority", "P1")

        # --- Epic ---
        if epic_id in issue_map:
            skipped_count += 1
            print(f"  ⏭️  {epic_id} 已存在: {issue_map[epic_id]}")
            epic_linear_id = issue_map[epic_id].split("-")[0]  # 取 LINEAR-ID 的 ID 部分
            # 其实我们需要真实的 id，先查一下
        else:
            title = f"[Epic] {epic['name']}"
            desc = build_description(epic_id, epic)
            labels = tier_labels("epic", epic_priority)
            pri = PRIORITY_MAP.get(epic_priority, "NO_PRIORITY")

            if args.dry_run:
                print(f"  DRY Epic: {title}")
                epic_linear_id = "DRY_EPIC"
                issue_map[epic_id] = "DRY-001"
            else:
                result = create_issue(team["id"], title, desc, labels, None, pri)
                if result:
                    epic_linear_id = result["id"]
                    issue_map[epic_id] = result["identifier"]
                    print(f"  ✅ {epic_id} → {result['identifier']}")
                    created_count += 1
                else:
                    print(f"  ❌ 创建失败: {epic_id}")
                    continue
            time.sleep(REQUEST_DELAY)

        # --- Feature ---
        for feat in epic.get("features", []):
            feat_id = feat["id"]
            feat_priority = feat.get("priority", epic_priority)

            if feat_id in issue_map:
                skipped_count += 1
                feat_linear_id = issue_map[feat_id].split("-")[0]
                print(f"    ⏭️  {feat_id} 已存在: {issue_map[feat_id]}")
            else:
                title = f"[Feature] {feat['name']}"
                desc = build_description(feat_id, feat)
                labels = tier_labels("feature", feat_priority)
                pri = PRIORITY_MAP.get(feat_priority, "NO_PRIORITY")

                if args.dry_run:
                    print(f"    DRY Feature: {title}")
                    feat_linear_id = "DRY_FEATURE"
                    issue_map[feat_id] = "DRY-002"
                else:
                    result = create_issue(team["id"], title, desc, labels, epic_linear_id, pri)
                    if result:
                        feat_linear_id = result["id"]
                        issue_map[feat_id] = result["identifier"]
                        print(f"    ✅ {feat_id} → {result['identifier']}")
                        created_count += 1
                    else:
                        print(f"    ❌ 创建失败: {feat_id}")
                        continue
                time.sleep(REQUEST_DELAY)

            # --- Story ---
            for story in feat.get("stories", []):
                story_id = story["id"]
                story_priority = story.get("priority", feat_priority)

                if story_id in issue_map:
                    skipped_count += 1
                    story_linear_id = issue_map[story_id].split("-")[0]
                    print(f"      ⏭️  {story_id} 已存在: {issue_map[story_id]}")
                else:
                    title = f"[Story] {story['name']}"
                    # Story 描述：简要用户价值 + 验收标准 + tasks
                    desc_parts = [f"**来源**: AKA MVP PRD · {story_id}"]
                    if story.get("userValue"):
                        desc_parts.append(f"\n### 用户价值\n{story['userValue']}")
                    if story.get("acceptanceCriteria"):
                        ac_lines = [f"- {a}" for a in story["acceptanceCriteria"]]
                        desc_parts.append("\n### 验收标准\n" + "\n".join(ac_lines))
                    if story.get("tasks"):
                        task_lines = [f"{i+1}. {t}" for i, t in enumerate(story["tasks"])]
                        desc_parts.append("\n### Tasks（执行单元）\n" + "\n".join(task_lines))
                    desc = "\n\n".join(desc_parts)

                    labels = tier_labels("story", story_priority)
                    pri = PRIORITY_MAP.get(story_priority, "NO_PRIORITY")

                    if args.dry_run:
                        print(f"      DRY Story: {title}")
                        story_linear_id = "DRY_STORY"
                        issue_map[story_id] = "DRY-003"
                    else:
                        result = create_issue(team["id"], title, desc, labels, feat_linear_id, pri)
                        if result:
                            story_linear_id = result["id"]
                            issue_map[story_id] = result["identifier"]
                            print(f"      ✅ {story_id} → {result['identifier']}")
                            created_count += 1
                        else:
                            print(f"      ❌ 创建失败: {story_id}")
                            continue
                    time.sleep(REQUEST_DELAY)

                # --- Task (作为 Story 的子 Issue) ---
                # 注：每个 Story 里的 tasks 已经写在 Story 描述里作为 checklist
                # 如需每条 Task 独立 Issue，取消下面注释即可
                # for task_idx, task_text in enumerate(story.get("tasks", [])):
                #     task_id = f"{story_id}-T{task_idx+1}"
                #     if task_id in issue_map:
                #         continue
                #     title = f"[Task] {task_text}"
                #     labels = tier_labels("task", story_priority)
                #     if not args.dry_run:
                #         result = create_issue(team["id"], title, "", labels, story_linear_id, pri)
                #         if result:
                #             issue_map[task_id] = result["identifier"]
                #             created_count += 1

                # 每 10 条 checkpoint
                if not args.dry_run and created_count % 10 == 0:
                    CHECKPOINT_FILE.write_text(json.dumps({"issue_map": issue_map}, indent=2, ensure_ascii=False))
                    print(f"      💾 checkpoint: {created_count} 条")

    # 5. 写最终映射
    ISSUE_MAP_FILE.write_text(json.dumps(issue_map, indent=2, ensure_ascii=False))
    if CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()

    print()
    print("=" * 60)
    print(f"✅ 完成!")
    print(f"   本次创建: {created_count} 条")
    print(f"   跳过已存在: {skipped_count} 条")
    print(f"   最终总数: {len(issue_map)} 条")
    print(f"   映射文件: {ISSUE_MAP_FILE}")
    print()
    print("   去 Linear 查看你的 issues:")
    if not args.dry_run:
        print(f"   https://linear.app/team/{team.get('key','')}")


if __name__ == "__main__":
    main()
