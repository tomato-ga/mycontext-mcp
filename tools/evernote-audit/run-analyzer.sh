#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
python_candidates=(
  "$HOME/.local/bin/python3"
  "/usr/bin/python3"
  "python3"
)

for python_candidate in "${python_candidates[@]}"; do
  if command -v "$python_candidate" >/dev/null 2>&1 \
    && "$python_candidate" -c 'import pyexpat' >/dev/null 2>&1; then
    exec "$python_candidate" "$script_dir/analyze_enex.py" "$@"
  fi
done

print -u2 "利用可能なPython XML実行環境が見つかりません"
exit 1
