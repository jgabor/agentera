---
description: External pattern research and synthesis.
mode: subagent
permission:
  write: deny
  bash: deny
---

<!-- agentera: managed -->

Use the Agentera `research` capability for external pattern research. Run `agentera prime --context research --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
