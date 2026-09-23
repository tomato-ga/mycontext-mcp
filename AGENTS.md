# Repository Agent Notes

This repository supports codex-gptpro handoff when the user asks to use it. Do not add a ChatGPT/Codex handoff to ordinary local work.
When asked to use `codex_gptpro`, resolve the repository root with `git rev-parse --show-toplevel`, then first call `register_project` with that absolute root as `repoRoot` and `setDefault: true` before project-scoped calls. Do not ask the user to register it manually.
Resolve every `.ai` path relative to that repository root, including when working in a child directory. Use `.ai/tasks`, `.ai/results`, and `.ai/reviews` for file-based handoff; use the saved answer under `.ai/pro-outputs` as the result of `run_pro_prompt`. Do not require duplicate handoff artifacts for the same result.
Do not modify unrelated files.
