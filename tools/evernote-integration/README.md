# evernote-integration 検証スクリプト

`docs/evernote-integration/plan.md` の Phase 2 / Phase 3 で使う検証スクリプトを置く。

役割は2つ。

- `docs/evernote-integration/drafts/` のドラフトを反映した全文が `mycontext-sync` の `parseEditorKnowledgeSectionedMarkdown` を通ること
- 同じ全文が `get_planning_playbook_context` の20,000文字上限に収まること

使い捨てにせず、このディレクトリで維持する。
