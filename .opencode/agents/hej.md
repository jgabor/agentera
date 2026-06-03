---
description: Agentera orientation and routing dashboard.
mode: subagent
permission:
  write: deny
  bash: deny
---

<!-- agentera: managed -->

Use the Agentera `hej` capability for orientation and routing. Run `agentera prime --context hej --format json` to fetch the authoritative instructions as a JSON capsule (the `prose` field carries the full Markdown body). Execute this capability directly in the current subagent session; do not invoke another subagent from inside this agent. Do not invent an `agentera hej` capability command beyond the supported state CLI.
