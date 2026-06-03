---
description: Multi-cycle orchestration over active plans.
mode: subagent
permission:
  write: allow
  bash: allow
---

<!-- agentera: managed -->

Use the Agentera `orkestrera` capability for multi-cycle orchestration. Run `agentera prime --context orkestrera --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
