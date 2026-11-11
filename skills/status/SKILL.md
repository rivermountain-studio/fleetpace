---
description: Check the agent fleet's usage-limit pace right now as one JSON object (verdict ok | tight | blocked | unknown). Use before launching several sub-agents or a large parallel task, or when the user asks whether they are close to their Claude Code or Codex limit.
argument-hint: "[--lang ko|en|ja|zh]"
---

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/engine-node/fleetpace-report.mjs" status --json $ARGUMENTS
```

Pass through only `--lang ko|en|ja|zh` from the user; ignore anything else. Do not read the log files yourself, and do not add other commands.

Read the JSON and reply in one or two sentences, using its `line` field as the main sentence:
- `verdict` is `tight` or `blocked`: say so first. If you were about to start a large team of sub-agents, stop and ask the user before launching it.
- `verdict` is `ok`: say the pace is fine and continue.
- `verdict` is `unknown`: say there is not enough history yet (Claude Code pace is estimated from past limit hits).

`claude.*` values are estimates (`approx: true`), so call them "about". `codex.*` values are the percentages Codex itself recorded.
