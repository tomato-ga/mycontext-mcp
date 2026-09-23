# codex-gptpro MCP Workflow

ChatGPT is the planner/reviewer. Codex is the executor.
Use `.ai/tasks` for implementation tasks, `.ai/results` for Codex reports, and `.ai/reviews` for review decisions.
When asked to use `codex_gptpro`, first call `register_project` for this repository with `setDefault: true`; do not ask the user to do registration manually.
Do not use codex-gptpro as a shell or patch application service.
