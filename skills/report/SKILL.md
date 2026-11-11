---
description: Show the Fleetpace report for this computer — how many usage-limit windows the agent fleet hit in the last 30 days, how early, which sub-agent teams burned the most, peak concurrency, idle hours and the pace right now. Use when the user asks about their Claude Code or Codex usage limits, rate limits, or which agents are using up the quota.
argument-hint: "[--days N] [--lang ko|en|ja|zh] [--html [file]]"
---

Run the Fleetpace report and show its output to the user unchanged (it is already formatted).

```
node "${CLAUDE_PLUGIN_ROOT}/engine-node/fleetpace-report.mjs" $ARGUMENTS
```

Rules:
- Pass through only these options from the user: `--days N`, `--lang ko|en|ja|zh`, `--html [file]`, `--no-cache`, `--project DIR`, `--claude-dir DIR`, `--codex-dir DIR`. Ignore anything else.
- Keep team and folder names masked. Add `--no-mask` only when the user explicitly asks to see the real names.
- Do not open or read the log files yourself. The script reads only timestamps, token counts, model names and rate-limit fields; it never reads conversation text or credentials and has no network code. Do not add other commands.
- The first run can take tens of seconds on large logs; later runs use the cache at `~/.fleetpace/cache-v1.json` and take a second or two.
- If it prints that no logs were found, tell the user it looks in `~/.claude/projects` and `~/.codex/sessions`, and that `--claude-dir` / `--codex-dir` point it elsewhere.
- After the output, add at most two short sentences on what stands out (for example the costliest limit hit, or the team that burned the most). Claude Code percentages are estimates ("about"); say so if you quote them.
