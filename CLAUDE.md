# Forge-Studio working rules

## Branch / PR hygiene

**ALWAYS check if the PR for a designated branch has been merged before working on it.** When the harness assigns a feature branch (e.g. `claude/foo-bar-AGYqw`), do not start editing on it without first verifying:

1. Run `gh`/MCP to find the associated PR (or check `git log main..<branch>` — if empty, it's already merged).
2. If the PR is merged or closed, STOP and tell the user — the branch is stale, do not commit on top of it.
3. Only proceed when the branch is genuinely open work.

Stale branches that have already shipped via merge should not receive new commits; new work belongs on a fresh branch off `main`.
