---
description: Decision profiling and preference memory.
mode: subagent
permission:
  write: allow
  bash: allow
---

<!-- agentera: managed -->

Use the Agentera `profile` capability for decision profiling. Run `agentera prime --context profile --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
