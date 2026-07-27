# Evernote全件ノウハウ監査

Evernoteデスクトップ版からノートブック単位で出力したENEXを走査し、ノウハウ候補の全件索引を作る。

## 入力

Evernote公式のデスクトップ版で、各ノートブックをENEX形式にエクスポートする。タグ、作成日、更新日などの属性を含める。

全ノートの取得確認には、同じノートブックを重ねて出力せず、26ノートブックを1回ずつ出力する。スタックはノートブックではないため、スタック単位の重複出力をしない。

## 実行

```bash
zsh tools/evernote-audit/run-analyzer.sh \
  /path/to/enex-directory \
  --output-dir /path/to/audit-output \
  --expect-count 9926
```

出力:

- `summary.json`: 全体件数、テーマ別件数、添付数、重複数、要更新確認数
- `notes-index.jsonl`: 1ノート1行の詳細索引
- `notes-index.csv`: 表計算ソフト用索引
- `candidate-inventory.md`: テーマ別の優先候補

生の本文は出力しない。索引には、認証情報らしい文字列とURLクエリを伏せた短い抜粋だけを保存する。

## 完了条件

1. `--expect-count 9926` が終了コード0になる。
2. ノートブック別件数の合計が9,926件になる。
3. 重複候補を確認し、重複エクスポートと実際の重複ノートを区別する。
4. 添付だけのノートをOCR対象として抽出する。
5. 高スコア候補を本人メモ、案件メモ、保存記事に分けて精読する。
6. 機密、健康、投資、採用、広告、古いSEO/SNS情報を確認してから最終文書へ転記する。

## テスト

```bash
/Users/ore/.local/bin/python3 -m unittest tools/evernote-audit/test_analyze_enex.py
```

このMacではHomebrewのPython 3.14とシステムXMLライブラリの組み合わせに不整合があるため、`run-analyzer.sh`がXMLを利用できるPythonを選ぶ。
