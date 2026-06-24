---
description: Metric-driven optimization cycles.
mode: subagent
permission:
  write: allow
  bash: allow
---

<!-- agentera: managed -->

Use the Agentera `optimize` capability for metric-driven optimization. Run `agentera prime --context optimize --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
