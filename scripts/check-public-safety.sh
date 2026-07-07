#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

tracked_disallowed="$(
  git ls-files | grep -E '(^|/)(MEMORY\.md|\.env|\.env\..+|\.dev\.vars|mirror\.config\.json|.*\.log|.*\.sqlite3?|.*\.db)$' || true
)"

tracked_disallowed="$(
  printf '%s\n' "$tracked_disallowed" |
    grep -v -E '(^|/)(\.env\.example|\.dev\.vars\.example)$' || true
)"

if [[ -n "$tracked_disallowed" ]]; then
  echo "Public safety check failed: tracked local/private files found." >&2
  printf '%s\n' "$tracked_disallowed" >&2
  exit 1
fi

secret_hits="$(
  git grep -n -E \
    '(ntn_[A-Za-z0-9]|gho_[A-Za-z0-9]|github_pat_|sk-[A-Za-z0-9]{20}|mysql://[^<[:space:]]*:[^<[:space:]]*@|MCP_ACCESS_TOKEN=[A-Za-z0-9_-]{16,}|TIDB_PASSWORD=[^<[:space:]]+|NOTION_API_KEY=ntn_)' \
    -- . ':(exclude)scripts/check-public-safety.sh' ':(exclude)**/pnpm-lock.yaml' || true
)"

if [[ -n "$secret_hits" ]]; then
  echo "Public safety check failed: possible secret values found in tracked files." >&2
  printf '%s\n' "$secret_hits" >&2
  exit 1
fi

personal_hits="$(
  git grep -n -E \
    '(大野|恭希|395625fe|Personal Context System|/Users/ore|/Volumes/SSD_2TB|memory\.db|\.longtermMemory)' \
    -- . ':(exclude).gitignore' ':(exclude)scripts/check-public-safety.sh' ':(exclude)**/pnpm-lock.yaml' || true
)"

if [[ -n "$personal_hits" ]]; then
  echo "Public safety check failed: possible personal/local identifiers found in tracked files." >&2
  printf '%s\n' "$personal_hits" >&2
  exit 1
fi

for local_path in \
  "notion-context-sync/.env" \
  "notion-context-sync/mirror.config.json" \
  "notion-context-mcp-worker/.dev.vars" \
  "MEMORY.md"; do
  if [[ -e "$local_path" ]] && ! git check-ignore -q "$local_path"; then
    echo "Public safety check failed: $local_path exists but is not ignored." >&2
    exit 1
  fi
done

echo "Public safety check passed."
