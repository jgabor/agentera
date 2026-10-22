---
name: agentera
description: >
  One agent, one CLI, many capabilities. Use for /agentera and Agentera
  capability requests. Prime serves the operating manual and starts the work.
version: "3.0.0"
capabilities:
  - status
  - vision
  - discuss
  - research
  - plan
  - build
  - optimize
  - audit
  - document
  - profile
  - design
  - orchestrate
---

# agentera

The CLI serves every Agentera rule; this file only says how to reach it. Use `npx -y agentera@next` until stable promotion. Send the request on stdin as `{"version":"agentera.route_request.v1","request":"<original request>"}`, never in argv.

| Request | Action |
|---|---|
| Bare `/agentera` | Send `/agentera` to `npx -y agentera@next prime --input -`. |
| `/agentera <capability> [topic]` | Send the request unchanged to `npx -y agentera@next prime --input -`. |
| Natural language | Send the original request to `npx -y agentera@next prime --input -`. |

Read the whole reply and follow its `manual` and the instructions it returns. Start nothing it does not return.

After context loss or compaction, rerun `npx -y agentera@next prime` before you continue.

If the CLI is missing, fails or returns output that does not parse, stop and report the command and its error. Do not improvise, use older guidance, or read checkout or installed companion files instead.
