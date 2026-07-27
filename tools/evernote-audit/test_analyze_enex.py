from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("analyze_enex.py")
SPEC = importlib.util.spec_from_file_location("analyze_enex", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


ENEX = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">
<en-export export-date="20260725T000000Z" application="Evernote" version="10">
  <note>
    <title>メディア編集方針チェックリスト</title>
    <content><![CDATA[
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
      <en-note><div>読者の課題を確認する</div><ul><li>目的</li><li>KPI</li><li>改善手順</li></ul></en-note>
    ]]></content>
    <created>20190101T120000Z</created>
    <updated>20190201T120000Z</updated>
    <tag>work</tag>
    <note-attributes><author>ore</author></note-attributes>
  </note>
  <note>
    <title>健康と投資の保存記事</title>
    <content><![CDATA[
      <en-note><div>password: should-not-leak</div><div>サプリと投資の情報</div></en-note>
    ]]></content>
    <created>20180101T120000Z</created>
    <note-attributes>
      <source>web.clip</source>
      <source-url>https://example.com/article?token=secret</source-url>
    </note-attributes>
    <resource>
      <data encoding="base64">YWJjZA==</data>
      <mime>application/pdf</mime>
      <resource-attributes><file-name>guide.pdf</file-name></resource-attributes>
    </resource>
  </note>
</en-export>
"""


class AnalyzeEnexTests(unittest.TestCase):
    def test_parse_and_classify(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "仕事.enex"
            path.write_text(ENEX, encoding="utf-8")
            notes = MODULE.parse_enex(path)
            MODULE.apply_duplicate_metadata(notes)

            self.assertEqual(len(notes), 2)
            first = notes[0].record
            second = notes[1].record
            self.assertIn("メディア戦略", first["themes"])
            self.assertIn("企画・編集・執筆", first["themes"])
            self.assertGreaterEqual(first["knowhow_score"], 8)
            self.assertEqual(second["source_type"], "web_clip")
            self.assertIn("health", second["sensitivity_flags"])
            self.assertIn("finance", second["sensitivity_flags"])
            self.assertIn("credential", second["sensitivity_flags"])
            self.assertTrue(second["needs_current_verification"])
            self.assertEqual(second["resources"][0]["bytes_approx"], 4)
            self.assertNotIn("should-not-leak", second["excerpt"])

    def test_duplicate_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            first_path = Path(temp) / "A.enex"
            second_path = Path(temp) / "B.enex"
            first_path.write_text(ENEX, encoding="utf-8")
            second_path.write_text(ENEX, encoding="utf-8")
            notes = MODULE.parse_enex(first_path) + MODULE.parse_enex(second_path)
            MODULE.apply_duplicate_metadata(notes)
            self.assertTrue(all(note.record["duplicate_count"] == 2 for note in notes))

    def test_cli_outputs_and_count_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            enex = root / "仕事.enex"
            output = root / "out"
            enex.write_text(ENEX, encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    str(enex),
                    "--output-dir",
                    str(output),
                    "--expect-count",
                    "2",
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / "notes-index.jsonl").exists())
            self.assertTrue((output / "notes-index.csv").exists())
            self.assertTrue((output / "candidate-inventory.md").exists())
            summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["note_count"], 2)

            mismatch = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    str(enex),
                    "--output-dir",
                    str(output),
                    "--expect-count",
                    "9926",
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(mismatch.returncode, 2)
            self.assertIn("件数不一致", mismatch.stderr)


if __name__ == "__main__":
    unittest.main()
