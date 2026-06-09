# Cursor adapter reference

Agentera v1 ships Cursor as two registry identities:

| Identity | Host | Support status |
| -------- | ---- | -------------- |
| `cursor` | Cursor IDE (Composer / Agent) | supported |
| `cursor-agent` | Cursor Agent CLI (`cursor-agent`, `agent`) | degraded |

Decision 63 owns v1 scope. Cloud agents are unsupported. Bare text `hej` routing
stays metadata-only like Claude, Copilot, and Codex.

## Quick install

**Local plugin (no Marketplace listing required)**

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
# or: ln -s /path/to/agentera ~/.cursor/plugins/local/agentera
```

Restart Cursor or run **Developer: Reload Window**. The plugin root must contain
`.cursor-plugin/plugin.json`. Agentera is not published to the Cursor Marketplace
yet; use this manual local path or Cursor's local plugin loading UI instead.

The plugin loads skills, managed capability agents, and plugin hooks. When you open
a project that is not an Agentera install root, `sessionStart` exports
`AGENTERA_HOME` from the plugin checkout (including a plugin-root fallback when env
and project walk-up do not resolve a managed root).

**Portable skill plus project upgrade**

```bash
npx skills add jgabor/agentera -g -a cursor --skill agentera -y
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --runtime cursor --yes
uvx --from git+https://github.com/jgabor/agentera agentera doctor --runtime cursor
```

Use the plugin path for a user-global install. Use upgrade when you need
project-committed `.cursor/hooks.json` and `.cursor/agents/` copies. Both paths can
be combined.

From a clone, replace `uvx … agentera` with `uv run scripts/agentera`. User-facing
install steps also live in [`README.md`](../../README.md) and
[`UPGRADE.md`](../../UPGRADE.md).

## Repo-native surfaces

This repository dogfoods committed Cursor surfaces:

- `.cursor/hooks.json` — sessionStart env export, preToolUse hard gate, postToolUse advisory validation
- `.cursor/agents/*.md` — twelve managed capability descriptors
- `.cursor-plugin/plugin.json` — marketplace submission-ready manifest

Hooks invoke the TypeScript CLI through `npx -y agentera hook …` (or
`npx -y agentera@next hook …` on the development channel). `sessionStart` exports
`AGENTERA_HOME` through Cursor hook JSON (`env`) before subsequent hook executions
run.

## AGENTERA_HOME wiring

Primary path: `agentera hook cursor-session-start` resolves the install root from
`AGENTERA_HOME`, project walk-up, the plugin/checkout root, or the platform default
app home when env and walk-up do not resolve a managed root, then returns
`{"env": {"AGENTERA_HOME": "<root>"}}` plus optional `additional_context` from
the shared session digest.

Fallback: `packages/cli/src/setup/cursor.ts` reports persistent shell configuration
only when live shell-tool smoke proves session env does not propagate to CLI
subprocesses. Agentera does not write shell rc files by default.

## Artifact validation

| Surface | Behavior | Claim status |
| ------- | -------- | ------------ |
| IDE `preToolUse` (Write/Edit) | Deny invalid reconstructable artifact candidates | Verified after live preToolUse Write smoke (2026-05-24) |
| IDE `postToolUse` (Write/Edit) | Advisory validation through shared `validate_artifact.py` | Active |
| CLI | Degraded; depends on workspace hook install and env propagation | Follows IDE smoke evidence only |

Live preToolUse Write smoke passed on 2026-05-24 with invalid-block and valid-allow
cases recorded in `.agentera/smoke-cursor-pretooluse-evidence.txt`. Conditional
hard-gate claims for reconstructable IDE Write and Edit candidates are verified;
release tagging and marketplace publication remain blocked pending broader release
closeout.

## Subagent dispatch

IDE: managed descriptors under `.cursor/agents/` with `<!-- agentera: managed -->`
ownership markers. Upgrade refreshes Agentera-owned targets and preserves unknown
collisions.

CLI: host-managed `cursor-agent` print mode; no separate TOML descriptor install.
Eval coverage targets `cursor-agent` first.

## Upgrade and doctor

```bash
uv run scripts/agentera upgrade --runtime cursor --dry-run
uv run scripts/agentera doctor --runtime cursor
```

Upgrade copies managed hooks, agents, and plugin metadata into target projects
with the same ownership protections used for OpenCode and Codex.

Doctor reports helper access, hook presence, and managed agent alignment.

## Eval

```bash
uv run scripts/eval_skills.py --runtime cursor-agent --skill hej --dry-run
```

Print mode uses `cursor-agent -p --output-format json --force`. Harnesses apply
bounded timeouts because some CLI builds hang after completion.

## Unsupported in v1

- Cloud agents (no project hook or managed-agent guarantees)
- Bare `hej` prompt rewrite routing
- Session compaction injection beyond shared hook helpers
- Separate cursor-agent hook install distinct from IDE workspace surfaces

## Profilera session corpus (Section 22)

Profilera mines five canonical record types from host session data. This section
maps each record type to Cursor IDE local storage on disk.

### Probe paths

| Path | Purpose |
| ---- | ------- |
| `~/.cursor/projects/` | Root directory for workspace-scoped Cursor state |
| `~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>/*.jsonl` | Agent session transcripts (Composer / Agent) |
| `~/.cursor/projects/<project-slug>/repo.json` | Workspace metadata (`id` UUID); slug mapping is primary for project scoping |
| `~/.config/cursor/chats/<md5(project-path)>/<session-id>/store.db` | Cursor Agent CLI chat store (gap-fill when JSONL absent) |

Override the projects root with `--cursor-projects-dir`, the CLI chats root with
`--cursor-chats-dir`, or disable both Cursor runtimes with `--no-cursor` on
`scripts/extract_corpus.py` and `agentera stats refresh`.

Project slug convention: absolute project path segments joined with `-`, lowercased
(for example `/home/user/git/agentera` → `home-user-git-agentera`). CLI workspace
hashes use `md5(absolute-project-path)` hex (same string Cursor uses under
`~/.config/cursor/chats/`). When `--project-root` is supplied, extraction prefers
matching slugs and workspace hashes over unrelated stores.

### Transcript JSONL shape

Each line is a JSON object:

```json
{"role": "user", "message": {"content": [{"type": "text", "text": "..."}]}}
{"role": "assistant", "message": {"content": [{"type": "text", "text": "..."}, {"type": "tool_use", "name": "grep", "input": {"pattern": "..."}}]}}
```

Roles are `user` or `assistant`. `message.content` is a list of blocks. Text blocks
use `type: "text"`. Tool blocks use `type: "tool_use"` with `name` and `input`.

### Cursor Agent CLI `store.db` shape

Runtime id `cursor-agent` reads SQLite stores at
`~/.config/cursor/chats/<workspace-hash>/<session-id>/store.db`. Each store has:

| Table | Purpose |
| ----- | ------- |
| `blobs` | JSON message payloads keyed by content hash (`role`, `content`, optional tool blocks) |
| `meta` | Session metadata (`agentId`, model, mode) |

JSON blobs use `role` values such as `user`, `assistant`, and `tool`. User content is
often a plain string; assistant content is a list that may include `text` and
`tool-call` items (`toolName`, `args`). Sessions that already have IDE JSONL under
`agent-transcripts/<same-session-id>/` are skipped (gap-fill only).

### Portable record families

| Family | Cursor source | Status |
| ------ | ------------- | ------ |
| Decision history | `history_prompt` from decision-rich user text blocks | Yes (local JSONL) |
| Conversation exchanges | `conversation_turn` from user/assistant lines | Yes (local JSONL) |
| Tool usage | `tool_call` from `tool_use` / `tool-call` blocks | Yes (bounded args) |
| Instruction documents | Project `AGENTS.md` via shared `--project-root` scan | Yes (filesystem) |
| Project config signals | Project manifests via shared `--project-root` scan | Yes (filesystem) |

### Degradation and privacy

Extraction is read-only and local-only. Runtime status uses the shared
`runtime_statuses` vocabulary (`ok`, `missing`, `sparse`, `degraded`, `skipped`).
Diagnostics report counts and bounded reasons only; raw transcript text must not
appear in errors, smoke output, or test assertions.

| Condition | Status | Reason |
| --------- | ------ | ------ |
| Store path disabled (`--no-cursor`) | `skipped` | `disabled` |
| `~/.cursor/projects` or `~/.config/cursor/chats` absent | `missing` | `store_absent` |
| No `*.jsonl` under `agent-transcripts` / no gap-fill `store.db` | `sparse` | `no_candidate_files` / `no_matching_records` |
| Permission denied | `degraded` | `store_locked` |
| Invalid JSONL lines | `degraded` | `schema_divergent` |
| Candidates present but no normalized records | `sparse` | `no_matching_records` |

### Gaps

- Numeric or opaque project directory names (no slug) skip filesystem project-path
  inference; `--project-root` mapping still scopes extraction when the slug matches.
- Cloud agent sessions do not write local `agent-transcripts` in v1.
- `cursor-agent` `store.db` sessions that already have IDE JSONL transcripts are skipped
  to avoid duplicate corpus records; gap-fill covers chat-only CLI sessions.
- Binary or non-JSON blobs in `store.db` degrade with bounded diagnostics and do not
  leak transcript text.

## Source of truth

RuntimeAdapter records live in
`references/adapters/runtime-adapter-registry.yaml`. Parity comparisons belong in
`references/adapters/runtime-feature-parity.md`.
