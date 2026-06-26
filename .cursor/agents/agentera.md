---
description: Agentera agent engine — orientation, routing, and capability dispatch.
---

<!-- agentera: managed -->

Load the Agentera skill for request routing and project orientation. When a capability is invoked, run `agentera prime --context build --format json` (or the relevant capability name) to fetch the authoritative instructions as a JSON capsule, then dispatch to a general-purpose subagent with the `prose` field as the task prompt. Do not invent unsupported capability-name CLI commands. Do not invoke per-capability subagents; the single Agentera agent handles all capability dispatch.
