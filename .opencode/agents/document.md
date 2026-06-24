---
description: Documentation updates and synchronization.
mode: subagent
permission:
  write: allow
  bash: deny
---

<!-- agentera: managed -->

Use the Agentera `document` capability for documentation updates. Run `agentera prime --context document --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent unsupported capability-name CLI commands.
