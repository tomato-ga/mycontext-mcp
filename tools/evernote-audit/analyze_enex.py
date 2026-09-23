#!/usr/bin/env python3
"""Build a privacy-conscious knowledge inventory from Evernote ENEX exports."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


THEMES: dict[str, tuple[str, ...]] = {
    "メディア戦略": (
        "メディア",
        "編集方針",
        "コンセプト",
        "ポジショニング",
        "読者",
        "ユーザー",
        "pv",
        "回遊",
        "媒体",
    ),
    "企画・編集・執筆": (
        "企画",
        "編集",
        "記事",
        "コンテンツ",
        "ライター",
        "ライティング",
        "タイトル",
        "取材",
        "校正",
        "ネタ",
        "構成",
    ),
    "SEO・SNS・集客": (
        "seo",
        "検索",
        "sns",
        "twitter",
        "facebook",
        "集客",
        "トラフィック",
        "ctr",
        "cvr",
        "流入",
    ),
    "収益化・広告": (
        "マネタイズ",
        "収益",
        "売上",
        "利益",
        "広告",
        "スポンサ",
        "課金",
        "サブスク",
        "ec",
        "単価",
    ),
    "営業・提案": (
        "営業",
        "提案",
        "クライアント",
        "顧客",
        "ヒアリング",
        "商談",
        "受注",
        "見積",
        "契約",
        "レポート",
    ),
    "組織・採用・育成": (
        "組織",
        "採用",
        "人材",
        "研修",
        "育成",
        "編集長",
        "マネジメント",
        "チーム",
        "1on1",
        "評価",
    ),
    "新規事業・プロダクト": (
        "新規事業",
        "事業",
        "起業",
        "プロダクト",
        "サービス",
        "仮説",
        "検証",
        "プロトタイプ",
        "リリース",
        "マーケティング",
    ),
    "キャリア・働き方": (
        "キャリア",
        "転職",
        "仕事",
        "働き方",
        "フリーランス",
        "独立",
        "副業",
        "目標",
        "okr",
        "生産性",
    ),
    "タスク・時間管理": (
        "タスク",
        "課題",
        "スケジュール",
        "時間",
        "優先順位",
        "進捗",
        "習慣",
        "振り返り",
        "チェックリスト",
        "テンプレート",
    ),
    "学習・読書": (
        "学習",
        "勉強",
        "読書",
        "本",
        "書評",
        "メモ",
        "知識",
        "スキル",
        "理解",
        "記憶",
    ),
    "健康・生活": (
        "ライフハック",
        "健康",
        "睡眠",
        "運動",
        "食事",
        "集中",
        "メンタル",
        "片付け",
        "整理",
        "生活",
        "サプリ",
    ),
    "お金・投資": (
        "お金",
        "家計",
        "投資",
        "貯蓄",
        "資産",
        "株",
        "ファンド",
        "保険",
        "税金",
        "節約",
    ),
}

KNOWHOW_TERMS: dict[str, int] = {
    "方法": 3,
    "手順": 4,
    "フロー": 4,
    "チェックリスト": 5,
    "テンプレート": 5,
    "マニュアル": 5,
    "体系": 5,
    "考え方": 4,
    "極意": 4,
    "原則": 4,
    "ポイント": 3,
    "改善": 3,
    "戦略": 3,
    "設計": 3,
    "研修": 3,
    "振り返り": 2,
    "気づき": 2,
    "学び": 2,
    "メモ": 1,
    "kpi": 3,
    "okr": 3,
    "課題": 2,
    "仮説": 3,
    "検証": 3,
}

SENSITIVE_PATTERNS: dict[str, tuple[str, ...]] = {
    "credential": (
        r"パスワード",
        r"password",
        r"api[\s_-]?key",
        r"access[\s_-]?token",
        r"secret",
        r"ログイン",
        r"認証コード",
        r"\botp\b",
    ),
    "personal": (
        r"恋愛",
        r"家族",
        r"セフレ",
        r"住所",
        r"電話番号",
        r"個人情報",
        r"原体験",
    ),
    "health": (
        r"病気",
        r"症状",
        r"薬",
        r"サプリ",
        r"メラトニン",
        r"うつ",
        r"診断",
        r"治療",
    ),
    "finance": (
        r"投資",
        r"資産",
        r"口座",
        r"年収",
        r"給与",
        r"株",
        r"ファンド",
        r"保有",
    ),
    "client_confidential": (
        r"見積",
        r"契約",
        r"クライアント",
        r"売上",
        r"単価",
        r"原価",
        r"社内",
        r"人材募集要件",
    ),
}

TIME_SENSITIVE_TERMS = (
    "seo",
    "sns",
    "twitter",
    "facebook",
    "広告",
    "法律",
    "著作権",
    "採用",
    "医療",
    "健康",
    "サプリ",
    "投資",
    "税",
    "補助金",
    "助成金",
    "アルゴリズム",
)

SECRET_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"(?i)\b(password|passwd|api[_ -]?key|access[_ -]?token|secret)"
            r"\s*[:=]\s*[^\s,;]{4,}"
        ),
        r"\1=[REDACTED]",
    ),
    (
        re.compile(r"(?i)(https?://[^\s?]+)\?[^\s]+"),
        r"\1?[REDACTED_QUERY]",
    ),
    (
        re.compile(r"(?<!\d)(?:\d[ -]?){12,19}(?!\d)"),
        "[REDACTED_NUMBER]",
    ),
)


class TextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "address",
        "blockquote",
        "br",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.ignored_depth += 1
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.ignored_depth:
            self.ignored_depth -= 1
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.ignored_depth:
            self.parts.append(data)

    def text(self) -> str:
        joined = html.unescape("".join(self.parts))
        joined = re.sub(r"[ \t\r\f\v]+", " ", joined)
        joined = re.sub(r"\n\s*\n+", "\n", joined)
        return joined.strip()


@dataclass
class ParsedNote:
    record: dict[str, object]
    fingerprint: str


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element: ET.Element, name: str) -> str:
    for child in element:
        if local_name(child.tag) == name:
            return (child.text or "").strip()
    return ""


def child(element: ET.Element, name: str) -> ET.Element | None:
    for item in element:
        if local_name(item.tag) == name:
            return item
    return None


def descendants(element: ET.Element, name: str) -> Iterable[ET.Element]:
    for item in element.iter():
        if local_name(item.tag) == name:
            yield item


def enml_to_text(enml: str) -> str:
    parser = TextExtractor()
    try:
        parser.feed(enml)
        parser.close()
        return parser.text()
    except Exception:
        no_tags = re.sub(r"<[^>]+>", " ", enml)
        return re.sub(r"\s+", " ", html.unescape(no_tags)).strip()


def redact_excerpt(value: str, limit: int = 320) -> str:
    compact = re.sub(r"\s+", " ", value).strip()
    for pattern, replacement in SECRET_REDACTIONS:
        compact = pattern.sub(replacement, compact)
    return compact[:limit]


def normalize_for_matching(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def parse_evernote_date(value: str) -> tuple[str, int | None]:
    if not value:
        return "", None
    try:
        parsed = datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
        return parsed.isoformat(), parsed.year
    except ValueError:
        return value, None


def classify_source(source: str, source_url: str, content: str, resources: list[dict[str, object]]) -> str:
    source_lower = source.lower()
    if source_url or source_lower in {"web.clip", "web.clip7", "mobile.share.extension"}:
        return "web_clip"
    if "mail" in source_lower or "email" in source_lower:
        return "email_clip"
    if resources and len(content.strip()) < 80:
        return "attachment_only"
    if resources and any(
        str(resource.get("mime", "")).startswith("image/")
        or resource.get("mime") == "application/pdf"
        for resource in resources
    ):
        return "mixed_with_attachment"
    return "original_or_unknown"


def theme_scores(title: str, content: str) -> dict[str, int]:
    title_text = normalize_for_matching(title)
    body_text = normalize_for_matching(content)
    scores: dict[str, int] = {}
    for theme, terms in THEMES.items():
        score = 0
        for term in terms:
            normalized_term = term.lower()
            if normalized_term in title_text:
                score += 4
            body_hits = body_text.count(normalized_term)
            score += min(body_hits, 5)
        if score:
            scores[theme] = score
    return scores


def knowhow_score(title: str, content: str, source_type: str, themes: dict[str, int]) -> int:
    text = normalize_for_matching(f"{title}\n{content}")
    title_text = normalize_for_matching(title)
    score = 0
    for term, weight in KNOWHOW_TERMS.items():
        term_lower = term.lower()
        if term_lower in title_text:
            score += weight * 2
        elif term_lower in text:
            score += weight
    char_count = len(content)
    if char_count >= 300:
        score += 2
    if char_count >= 1_000:
        score += 2
    if char_count >= 3_000:
        score += 2
    if len(re.findall(r"(?:^|\n)\s*(?:[-・*]|\d+[.)、])", content)) >= 3:
        score += 2
    if len(themes) >= 2:
        score += 1
    if source_type == "web_clip":
        score -= 2
    if source_type == "attachment_only":
        score -= 1
    return max(score, 0)


def sensitivity_flags(title: str, content: str) -> list[str]:
    text = normalize_for_matching(f"{title}\n{content}")
    flags = [
        flag
        for flag, patterns in SENSITIVE_PATTERNS.items()
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)
    ]
    return flags


def needs_current_verification(title: str, content: str, year: int | None) -> bool:
    if year is None or year >= datetime.now().year - 3:
        return False
    text = normalize_for_matching(f"{title}\n{content}")
    return any(term in text for term in TIME_SENSITIVE_TERMS)


def parse_note(
    note: ET.Element,
    source_file: Path,
    ordinal: int,
    resource_sizes: list[int],
) -> ParsedNote:
    title = child_text(note, "title") or "無題"
    content_element = child(note, "content")
    enml = content_element.text if content_element is not None and content_element.text else ""
    content = enml_to_text(enml)
    created_raw = child_text(note, "created")
    updated_raw = child_text(note, "updated")
    created, created_year = parse_evernote_date(created_raw)
    updated, _ = parse_evernote_date(updated_raw)
    tags = [item.text.strip() for item in descendants(note, "tag") if item.text and item.text.strip()]

    attributes = child(note, "note-attributes")
    source = child_text(attributes, "source") if attributes is not None else ""
    source_url = child_text(attributes, "source-url") if attributes is not None else ""
    author = child_text(attributes, "author") if attributes is not None else ""

    resources: list[dict[str, object]] = []
    for index, resource in enumerate(descendants(note, "resource")):
        resource_attributes = child(resource, "resource-attributes")
        file_name = (
            child_text(resource_attributes, "file-name") if resource_attributes is not None else ""
        )
        resources.append(
            {
                "mime": child_text(resource, "mime"),
                "file_name": file_name,
                "bytes_approx": resource_sizes[index] if index < len(resource_sizes) else 0,
            }
        )

    source_type = classify_source(source, source_url, content, resources)
    scores = theme_scores(title, content)
    selected_themes = [
        theme for theme, score in sorted(scores.items(), key=lambda item: (-item[1], item[0])) if score >= 4
    ][:4]
    note_id_seed = f"{source_file.resolve()}\0{ordinal}\0{title}\0{created_raw}"
    note_id = hashlib.sha256(note_id_seed.encode("utf-8", "replace")).hexdigest()[:16]
    normalized_content = normalize_for_matching(content)
    fingerprint_seed = normalized_content or normalize_for_matching(title)
    fingerprint = hashlib.sha256(fingerprint_seed.encode("utf-8", "replace")).hexdigest()

    record: dict[str, object] = {
        "note_id": note_id,
        "source_file": str(source_file.resolve()),
        "notebook_hint": source_file.stem,
        "ordinal": ordinal,
        "title": title,
        "created": created,
        "updated": updated,
        "created_year": created_year,
        "tags": sorted(set(tags)),
        "source": source,
        "source_url": source_url,
        "author": author,
        "source_type": source_type,
        "char_count": len(content),
        "resource_count": len(resources),
        "resources": resources,
        "theme_scores": scores,
        "themes": selected_themes,
        "knowhow_score": knowhow_score(title, content, source_type, scores),
        "sensitivity_flags": sensitivity_flags(title, content),
        "needs_current_verification": needs_current_verification(title, content, created_year),
        "excerpt": redact_excerpt(content),
    }
    return ParsedNote(record=record, fingerprint=fingerprint)


def parse_enex(path: Path) -> list[ParsedNote]:
    parsed: list[ParsedNote] = []
    resource_sizes: list[int] = []
    ordinal = 0
    in_note = False
    try:
        events = ET.iterparse(path, events=("start", "end"))
        for event, element in events:
            name = local_name(element.tag)
            if event == "start" and name == "note":
                in_note = True
                resource_sizes = []
            elif event == "end" and in_note and name == "data":
                encoded = re.sub(r"\s+", "", element.text or "")
                padding = encoded[-2:].count("=") if encoded else 0
                resource_sizes.append(max((len(encoded) * 3) // 4 - padding, 0))
                element.clear()
            elif event == "end" and in_note and name == "recognition":
                element.clear()
            elif event == "end" and name == "note":
                ordinal += 1
                parsed.append(parse_note(element, path, ordinal, resource_sizes))
                element.clear()
                in_note = False
    except ET.ParseError as exc:
        raise RuntimeError(f"ENEXのXML解析に失敗: {path}: {exc}") from exc
    return parsed


def collect_enex_files(inputs: list[Path]) -> list[Path]:
    files: list[Path] = []
    for item in inputs:
        if item.is_dir():
            files.extend(
                path for path in item.rglob("*")
                if path.is_file() and path.suffix.lower() == ".enex"
            )
        elif item.is_file() and item.suffix.lower() == ".enex":
            files.append(item)
        else:
            raise FileNotFoundError(f"ENEXファイルまたはディレクトリが見つかりません: {item}")
    unique = sorted({path.resolve() for path in files})
    if not unique:
        raise FileNotFoundError("ENEXファイルが見つかりません")
    return unique


def apply_duplicate_metadata(notes: list[ParsedNote]) -> None:
    groups: dict[str, list[ParsedNote]] = defaultdict(list)
    for note in notes:
        groups[note.fingerprint].append(note)
    for fingerprint, group in groups.items():
        if len(group) < 2:
            for note in group:
                note.record["duplicate_count"] = 1
                note.record["duplicate_group"] = ""
            continue
        duplicate_group = fingerprint[:12]
        for note in group:
            note.record["duplicate_count"] = len(group)
            note.record["duplicate_group"] = duplicate_group


def build_summary(notes: list[ParsedNote], files: list[Path]) -> dict[str, object]:
    records = [note.record for note in notes]
    theme_counts = Counter(
        theme for record in records for theme in record.get("themes", []) if isinstance(theme, str)
    )
    source_counts = Counter(str(record["source_type"]) for record in records)
    notebook_counts = Counter(str(record["notebook_hint"]) for record in records)
    flag_counts = Counter(
        flag
        for record in records
        for flag in record.get("sensitivity_flags", [])
        if isinstance(flag, str)
    )
    attachment_notes = sum(1 for record in records if int(record["resource_count"]) > 0)
    duplicate_notes = sum(1 for record in records if int(record["duplicate_count"]) > 1)
    candidates = sum(1 for record in records if int(record["knowhow_score"]) >= 8)
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "input_files": [str(path) for path in files],
        "input_file_count": len(files),
        "note_count": len(records),
        "candidate_count_score_gte_8": candidates,
        "attachment_note_count": attachment_notes,
        "duplicate_note_count": duplicate_notes,
        "needs_current_verification_count": sum(
            1 for record in records if record["needs_current_verification"]
        ),
        "source_type_counts": dict(source_counts.most_common()),
        "notebook_counts": dict(notebook_counts.most_common()),
        "theme_counts": dict(theme_counts.most_common()),
        "sensitivity_flag_counts": dict(flag_counts.most_common()),
    }


def write_jsonl(path: Path, notes: list[ParsedNote]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for note in notes:
            handle.write(json.dumps(note.record, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def write_csv(path: Path, notes: list[ParsedNote]) -> None:
    fieldnames = [
        "note_id",
        "notebook_hint",
        "ordinal",
        "title",
        "created",
        "updated",
        "source_type",
        "char_count",
        "resource_count",
        "themes",
        "knowhow_score",
        "sensitivity_flags",
        "needs_current_verification",
        "duplicate_count",
        "excerpt",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for parsed in notes:
            record = parsed.record
            writer.writerow(
                {
                    field: " / ".join(record[field])
                    if isinstance(record.get(field), list)
                    else record.get(field, "")
                    for field in fieldnames
                }
            )


def markdown_escape(value: str) -> str:
    return value.replace("|", r"\|").replace("\n", " ")


def write_inventory(
    path: Path,
    notes: list[ParsedNote],
    summary: dict[str, object],
    min_score: int,
    top_per_theme: int,
) -> None:
    records = [note.record for note in notes]
    candidates = [
        record
        for record in records
        if int(record["knowhow_score"]) >= min_score and record.get("themes")
    ]
    lines = [
        "# Evernote全件ノウハウ候補 自動索引",
        "",
        f"生成日時: {summary['generated_at']}  ",
        f"ENEXファイル数: {summary['input_file_count']}  ",
        f"解析ノート数: {summary['note_count']}  ",
        f"候補閾値: knowhow_score >= {min_score}",
        "",
        "この索引は候補抽出用。保存記事と本人の原則を区別し、機密・健康・投資・古い情報は本文転記前に確認する。",
        "",
        "## 集計",
        "",
        f"- 添付を含むノート: {summary['attachment_note_count']}",
        f"- 重複候補に属するノート: {summary['duplicate_note_count']}",
        f"- 現行情報の再確認が必要: {summary['needs_current_verification_count']}",
        "",
    ]

    for theme in THEMES:
        themed = [record for record in candidates if theme in record.get("themes", [])]
        themed.sort(
            key=lambda record: (
                -int(record["knowhow_score"]),
                -int(record["char_count"]),
                str(record["title"]),
            )
        )
        if not themed:
            continue
        lines.extend(
            [
                f"## {theme}",
                "",
                "| Score | ノート | 種別 | 年 | 添付 | 注意 | ID |",
                "|---:|---|---|---:|---:|---|---|",
            ]
        )
        for record in themed[:top_per_theme]:
            flags = list(record.get("sensitivity_flags", []))
            if record.get("needs_current_verification"):
                flags.append("要更新確認")
            if int(record.get("duplicate_count", 1)) > 1:
                flags.append(f"重複{record['duplicate_count']}")
            lines.append(
                "| {score} | {title} | {source_type} | {year} | {resources} | {flags} | `{note_id}` |".format(
                    score=record["knowhow_score"],
                    title=markdown_escape(str(record["title"])),
                    source_type=record["source_type"],
                    year=record.get("created_year") or "",
                    resources=record["resource_count"],
                    flags=markdown_escape(" / ".join(flags)),
                    note_id=record["note_id"],
                )
            )
        lines.append("")

    lines.extend(
        [
            "## 次の精読順",
            "",
            "1. 高スコアかつ `original_or_unknown` のノート",
            "2. 高スコアの `mixed_with_attachment`",
            "3. `attachment_only` をOCR",
            "4. `web_clip` は出典を付け、本人の知見と分離",
            "5. 機密フラグと要更新確認を解消してからノウハウ本文へ転記",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evernote ENEXを全件走査し、ノウハウ候補索引を作ります。"
    )
    parser.add_argument("inputs", nargs="+", type=Path, help="ENEXファイルまたはディレクトリ")
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="索引出力先。既存ファイルは同名のみ上書きします。",
    )
    parser.add_argument(
        "--expect-count",
        type=int,
        default=None,
        help="期待ノート件数。不一致なら終了コード2にします。",
    )
    parser.add_argument("--min-score", type=int, default=8)
    parser.add_argument("--top-per-theme", type=int, default=100)
    return parser


def run(args: argparse.Namespace) -> int:
    files = collect_enex_files(args.inputs)
    all_notes: list[ParsedNote] = []
    for path in files:
        all_notes.extend(parse_enex(path))
    apply_duplicate_metadata(all_notes)
    all_notes.sort(
        key=lambda note: (
            str(note.record["notebook_hint"]),
            int(note.record["ordinal"]),
        )
    )
    summary = build_summary(all_notes, files)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(args.output_dir / "notes-index.jsonl", all_notes)
    write_csv(args.output_dir / "notes-index.csv", all_notes)
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_inventory(
        args.output_dir / "candidate-inventory.md",
        all_notes,
        summary,
        args.min_score,
        args.top_per_theme,
    )

    print(
        json.dumps(
            {
                "note_count": summary["note_count"],
                "output_dir": str(args.output_dir.resolve()),
                "expected": args.expect_count,
            },
            ensure_ascii=False,
        )
    )
    if args.expect_count is not None and summary["note_count"] != args.expect_count:
        print(
            f"件数不一致: expected={args.expect_count} actual={summary['note_count']}",
            file=sys.stderr,
        )
        return 2
    return 0


def main() -> int:
    return run(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
