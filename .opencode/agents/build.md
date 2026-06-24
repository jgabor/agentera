---
description: Autonomous development execution.
mode: subagent
permission:
  write: allow
  bash: allow
---

<!-- agentera: managed -->

Use the Agentera `build` capability for autonomous development execution. Run `agentera prime --context build --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
