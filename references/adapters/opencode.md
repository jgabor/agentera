# OpenCode Adapter

Maps agentera's host adapter contract (SPEC.md Section 21) and session corpus contract (SPEC.md Section 22) to OpenCode's specific mechanisms. A developer reading only this document can implement portable-core agentera support and a profilera-compatible session corpus in OpenCode without reading any SKILL.md source code.

---

## Implementation Status

Status: production reference (formerly design document).

| Component | Status | Location |
|-----------|--------|----------|
| Hook plugin | Shipped | `.opencode/plugins/agentera.js` |
| Eval runner support | Shipped | `scripts/eval_skills.py --runtime opencode` |
| Skill install | Documented below | `~/.config/opencode/skills/<name>/` via symlinks |
| Profile path | Documented below | `~/.config/opencode/profile/PROFILE.md` |

The plugin was promoted from `references/adapters/opencode-plugin.js` to `.opencode/plugins/agentera.js` and is now the production location. Install it with:

```bash
cp .opencode/plugins/agentera.js ~/.config/opencode/plugins/
```

---

## Section 21: Host Adapter Capability Mapping

### Skill discovery (Required)

**What agentera requires**: A mechanism to find and load SKILL.md files so the runtime can present available skills to the user.

**OpenCode mechanism**: OpenCode discovers skills from multiple directory conventions, walking up from the current working directory to the git worktree root.

OpenCode skill search paths:

| Location | Scope |
|----------|-------|
| `.opencode/skills/<name>/SKILL.md` | Project-local |
| `.claude/skills/<name>/SKILL.md` | Project-local (Claude Code compatibility) |
| `.agents/skills/<name>/SKILL.md` | Project-local (agent-compatible) |
| `~/.config/opencode/skills/<name>/SKILL.md` | Global |
| `~/.claude/skills/<name>/SKILL.md` | Global (Claude Code compatibility) |
| `~/.agents/skills/<name>/SKILL.md` | Global (agent-compatible) |

**Adapter approach**: Install agentera's `skills/*/` directories into one of the recognized skill directories. The recommended approach:

- Global install: symlink or copy `skills/*/` into `~/.config/opencode/skills/` or `~/.agents/skills/`
- Project install: symlink or copy into `.opencode/skills/` or `.agents/skills/`

Each agentera SKILL.md already contains YAML frontmatter with `name` and `description`, which matches OpenCode's frontmatter requirements exactly. No transformation needed.

**OpenCode frontmatter validation** requires: `name` (1-64 chars, lowercase alphanumeric with single hyphens), `description` (1-1024 chars). Agentera skill names use Swedish verb stems with `-era` suffix (e.g., `realisera`, `inspektera`), all lowercase, matching the validation regex `^[a-z0-9]+(-[a-z0-9]+)*$`.

**Skill loading**: OpenCode loads skills on-demand via a native `skill` tool. Agents see available skills listed in the tool description and load full content by calling `skill({ name: "realisera" })`. Agentera skills work unmodified: they are loaded into the agent's context when invoked.

**Gap**: None. OpenCode's skill discovery is more flexible than Claude Code's (supports `.opencode/`, `.claude/`, and `.agents/` paths). Agentera skills install cleanly.

### Artifact resolution (Required)

**What agentera requires**: Ability to read and write files at paths specified by DOCS.md or the default layout (project root + `.agentera/`).

**OpenCode mechanism**: Direct filesystem access. OpenCode agents have full file read/write capabilities through their `read`, `write`, and `edit` tools. The runtime places no restrictions on which paths an agent can access beyond what the host OS enforces.

**Adapter approach**: No adapter code needed. The default agentera layout (VISION.md, TODO.md, CHANGELOG.md at root; everything else in `.agentera/`) works directly. DOCS.md path overrides are also filesystem paths and resolve normally.

**Gap**: None. Artifact resolution is pure filesystem access, identical between runtimes.

### Profile path (Required)

**What agentera requires**: A global configuration directory where PROFILE.md lives, readable by all skills that consume the generated profile artifact.

**OpenCode mechanism**: Global configuration lives in `~/.config/opencode/`. This path is consistent across platforms (Linux and macOS). Managed/admin settings on macOS use `/Library/Application Support/opencode/`, but user-level global config is always `~/.config/opencode/`.

**Adapter approach**: Place PROFILE.md at `~/.config/opencode/profile/PROFILE.md` (or `~/.config/opencode/PROFILE.md` for simplicity). Update the profile-path references:

- Skills reference `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) with `<!-- platform: profile-path -->` annotations
- The OpenCode adapter substitutes `~/.config/opencode/profile/PROFILE.md`
- Profilera writes to this path when generating the profile

**Concrete substitution**: In contract.md files, the annotated line:

```
Read PROFILE.md from the profilera-determined profile path (`$PROFILERA_PROFILE_DIR/PROFILE.md`, defaulting to `$XDG_DATA_HOME/agentera/PROFILE.md` on Linux). <!-- platform: profile-path -->
```

becomes in the OpenCode context:

```
Read PROFILE.md from the runtime-provided profile path (Section 21). In OpenCode, this resolves to `~/.config/opencode/profile/PROFILE.md`.
```

**Gap**: None. The path convention is straightforward. The XDG-compliant location is well-established.

### Sub-agent dispatch (Capability-gated)

**What agentera requires**: Ability to spawn subordinate agents with workspace isolation for parallel implementation tasks.

**OpenCode mechanism**: OpenCode has a built-in subagent system:

1. **Subagents via Task tool**: Primary agents can invoke subagents (e.g., `@general`, `@explore`) using the Task tool. These run in child sessions within the same project. Custom subagents can be defined via JSON config or markdown files in `.opencode/agents/` or `~/.config/opencode/agents/`.

2. **Git worktree isolation (manual)**: OpenCode does not include a built-in worktree primitive. Workspace isolation can be achieved by using standard `git worktree` commands before dispatching subagents, then merging branches after completion.

**Adapter approach**: Map agentera's worktree isolation to one of two strategies:

**Strategy A: Task tool dispatch (recommended for initial port)**

- Define agentera's dispatched agents as OpenCode subagents
- Each subagent gets a markdown file in `.opencode/agents/` with the appropriate prompt and permissions
- The orchestrating skill (realisera, orkestrera) uses `@subagent-name` to invoke work
- Limitation: runs in the same working tree, not isolated. Suitable for non-destructive work.

**Strategy B: Manual git worktree (full isolation parity)**

- Create a git worktree via `git worktree add` before dispatching
- Dispatch a subagent into the worktree directory
- Merge the branch and clean up the worktree after completion
- Provides true parallel implementation with independent branches
- Requires explicit orchestration in the skill workflow

**Concrete mapping for realisera Step 5 dispatch**:

```
# Claude Code (reference)
Spawn a Sonnet implementation agent in a worktree (isolation: "worktree")

# OpenCode Strategy A
Invoke @general subagent with the implementation plan via the Task tool

# OpenCode Strategy B
git worktree add ../worktree-branch branch-name
Dispatch @general subagent with cwd set to ../worktree-branch
After completion: git merge, git worktree remove
```

**Gap**: Strategy A lacks workspace isolation (same working tree). Strategy B requires manual git worktree orchestration in the skill workflow. For the initial portable-core port, Strategy A is sufficient because realisera and orkestrera are capability-gated skills, not portable-core requirements.

### Eval mechanism (Capability-gated)

**What agentera requires**: Ability to invoke a skill against a prompt and capture the output for behavioral verification.

**OpenCode mechanism**: OpenCode supports non-interactive execution via CLI:

```bash
opencode run "Run one autonomous development cycle."
```

This pipes a prompt to OpenCode and returns the agent's response. The output format is text by default, but structured JSON is available:

```bash
# Text output (default)
opencode run "Explain closures in JavaScript"

# Raw JSON event stream
opencode run --format json "Explain closures in JavaScript"
```

The `--format json` flag produces a raw JSON event stream, comparable to `claude -p --output-format json`. Each event is a separate JSON object representing a message part, tool call, or status update.

For long-running sessions, OpenCode's server mode provides an HTTP API with the same structured output:

```bash
opencode serve --port 4096
# Then POST to the API with session creation and message sending
```

**Adapter approach**: Map `claude -p --output-format json` to `opencode run --format json`:

| Claude Code | OpenCode |
|-------------|----------|
| `claude -p "prompt"` | `opencode run "prompt"` |
| `claude -p --output-format json` | `opencode run --format json "prompt"` |
| `claude -p --skill realisera` | `opencode run "prompt"` (skill loaded via discovery) |

The agentera eval runner (`scripts/eval_skills.py`) would need an OpenCode dispatch mode that calls `opencode run --format json` instead of `claude -p --output-format json`. The dispatch wrapper:

```python
def dispatch_opencode(skill_name: str, prompt: str) -> dict:
    result = subprocess.run(
        ["opencode", "run", "--format", "json", prompt],
        capture_output=True, text=True, timeout=120
    )
    return {"output": result.stdout, "exit_code": result.returncode}
```

**Gap**: Minimal. `opencode run --format json` provides structured JSON events directly comparable to `claude -p --output-format json`. The eval runner adapter parses the JSON event stream using the same pattern as the Claude Code adapter, though the event schema differs and requires a separate parser module. For smoke tests (the eval runner's primary use case), text output with exit-code checking is also sufficient.

### Hook lifecycle (Optional but recommended)

**What agentera requires**: Callbacks at session start, session stop, before tool use for hard-gated artifact validation, and after tool use for validation warnings.

**OpenCode mechanism**: OpenCode provides a rich plugin event system. Session lifecycle events arrive through the generic `event` hook as `event.type` payload values. The documented plugin example branches on `event.type === "session.idle"` inside `event`, and the local `@opencode-ai/plugin` types expose `event?: ({ event }) => Promise<void>`.

| Agentera hook | OpenCode event | Notes |
|---------------|----------------|-------|
| SessionStart | `event` hook with `event.type === "session.created"` | Observation only unless a supported context-injection hook is also used |
| Stop | `event` hook with `event.type === "session.idle"` | Fires when a session reaches idle state |
| PreToolUse | `tool.execute.before` | Blocks invalid reconstructable artifact candidates by throwing an error |
| PostToolUse | `tool.execute.after` | Fires after every tool execution |

OpenCode plugins subscribe to session events by exporting one generic `event` hook:

```javascript
export const AgenteraPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // Stop equivalent: persist session bookmark
      }

      if (event.type === "session.created") {
        // SessionStart observation point.
      }
    },
    "tool.execute.before": async (input, output) => {
      // PreToolUse equivalent: deny invalid reconstructable artifact candidates
    },
    "tool.execute.after": async (input, output) => {
      // PostToolUse equivalent: report validation warnings
    }
  }
}
```

**Adapter approach**: Implement agentera's three hooks as an OpenCode plugin in `.opencode/plugins/agentera.js`:

1. **SessionStart** (`event.type === "session.created"`): Observe session creation through the event hook. Session-start context preload remains deferred because no supported model-context injection path is verified for this adapter. Do not attach dead preload code to event observation alone.

2. **PreToolUse** (`tool.execute.before`): When `write` or `edit` args expose a path plus candidate content or exact replacement evidence, validate the candidate through `hooks/validate_artifact.py`. Throw an error to block invalid artifact content before mutation. Sparse payloads and `apply_patch` `patchText` without reconstructed full content are allowed rather than guessed.

3. **PostToolUse** (`tool.execute.after`): After `write` or `edit`, run the shared artifact validator for warnings. This is advisory because the mutation already happened.

4. **Stop** (`event.type === "session.idle"`): Append a bookmark entry to `.agentera/SESSION.md` capturing artifact changes for next-session continuity.

**Gap**: OpenCode plugins run in-process (JavaScript/TypeScript), not as separate Python scripts. The Python validation scripts (`validate_spec.py`, `generate_contracts.py`) would need to be invoked via the `$` shell API:

```javascript
const result = await $`python3 /path/to/scripts/validate_spec.py`.quiet()
```

This is functional but adds a Python dependency. For the initial port, the hook plugin can be a thin shim that calls the existing Python scripts.

---

## Section 22: Session Corpus Mapping

Profilera mines five canonical record types from host session data. This section maps each record type to OpenCode's data sources.

### memory_entry (Claude Code runtime extension)

**Agentera contract**: This record type is a Claude Code runtime extension, not part of the portable corpus. Claude Code's memory files are emitted as instruction_document records with `doc_type: "claude_memory"`.

**OpenCode source**: OpenCode does not have a built-in memory system. The memory_entry extension does not apply.

**Gap**: None. memory_entry is not a portable requirement. OpenCode adapters need not implement it.

### instruction_document

**Agentera contract**: Global or project-scoped instruction files the host exposes to agents.

**OpenCode source**: OpenCode has explicit support for instruction documents at multiple levels:

| Source | Scope | Notes |
|--------|-------|-------|
| `~/.config/opencode/AGENTS.md` | Global | Personal rules applied across all sessions |
| `<project>/AGENTS.md` | Project | Project-specific rules, committed to git |
| `<project>/CLAUDE.md` | Project | Claude Code compatibility (fallback if no AGENTS.md) |
| `opencode.json` `instructions` | Configurable | Explicit list of paths and glob patterns |
| Remote URLs in `instructions` | Configurable | Web-hosted instruction files |

**Adapter extraction**: Straightforward. Read each instruction source and produce an instruction_document record:

```python
{
    "source_id": f"opencode:instruction:{scope}:{name}",
    "timestamp": iso_now,
    "project_id": project_id,
    "source_kind": "instruction_document",
    "runtime": "opencode",
    "adapter_version": "1.0.0",
    "doc_type": "agents_md",
    "name": name,
    "content": file_content,
    "scope": scope  # "global" or "project"
}
```

**Gap**: None. OpenCode has richer instruction document support than Claude Code (remote URLs, glob patterns, explicit config).

### history_prompt

**Agentera contract**: Decision-rich prompts from the host's command history.

**OpenCode source**: OpenCode stores session data in its internal database. Sessions are accessible via the SDK:

```typescript
// OpenCode SDK session access
const sessions = await client.session.list()
const messages = await client.session.messages({ path: { id: session.id } })
```

The SDK exposes message history with timestamps, project context, and session metadata.

**Adapter extraction**:

1. Enumerate sessions via `opencode session list --format json`
2. Export each session via `opencode export [sessionID]`
3. Filter for user-originated messages from the export JSON
4. Apply decision-pattern regex (same patterns profilera uses for Claude Code history) to classify prompts as `"decision"`, `"correction"`, or `"question"`
5. Produce history_prompt records with session and project metadata

```python
{
    "source_id": f"opencode:history:{session_id}:{message_index}",
    "timestamp": message_timestamp,
    "project_id": project_id,
    "session_id": session_id,
    "source_kind": "history_prompt",
    "runtime": "opencode",
    "adapter_version": "1.0.0",
    "prompt": user_message_text,
    "signal_type": classify_signal(user_message_text)
}
```

**Gap**: Reduced. OpenCode provides CLI-based session data access via two mechanisms:

1. `opencode session list --format json`: Lists sessions with metadata (timestamps, project, title).
2. `opencode export [sessionID]`: Exports full session data (messages, tool calls, metadata) as JSON.

The `opencode export` output is a JSON dump of the session, which can be parsed to extract user prompts, classify signal types, and produce history_prompt records without requiring SDK access. The adapter can shell out to `opencode session list --format json` to enumerate sessions, then `opencode export <id>` for each.

The SDK approach remains preferable for programmatic integration (e.g., as an OpenCode plugin), but CLI-based extraction is viable for the initial port. This source family no longer needs to be deferred.

### conversation_turn

**Agentera contract**: Normalized user or assistant turns from host conversation sessions.

**OpenCode source**: Same session data as history_prompt, but capturing the full user-assistant exchange pairs.

**Adapter extraction**:

1. Enumerate sessions via `opencode session list --format json`
2. Export each session via `opencode export [sessionID]`
3. Extract paired user-assistant turns from the export JSON
4. Classify user turns by signal type (decision, correction, question)
5. Include preceding_context for turns that respond to assistant proposals

```python
{
    "source_id": f"opencode:turn:{session_id}:{turn_index}",
    "timestamp": turn_timestamp,
    "project_id": project_id,
    "session_id": session_id,
    "source_kind": "conversation_turn",
    "runtime": "opencode",
    "adapter_version": "1.0.0",
    "actor": "user" or "assistant",
    "content": turn_text,
    "preceding_context": prior_assistant_proposal,  # for user turns
    "signal_type": signal_classification
}
```

**Gap**: Same as history_prompt: reduced. `opencode export [sessionID]` provides full session JSON including paired user-assistant turns. CLI-based extraction is viable for the initial port.

### project_config_signal

**Agentera contract**: Recurring configuration or toolchain patterns associated with a project.

**OpenCode source**: OpenCode projects are standard filesystem directories. Config files are accessible via direct file reads.

**Adapter extraction**: Identical to Claude Code extraction. Scan the project root for known config types:

- `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`
- `.golangci.yml`, `tsconfig.json`, `ruff.toml`
- `Makefile`, `magefile.go`, `justfile`, `taskfile.yaml`

No runtime-specific adaptation needed. The adapter uses the same config type list and extraction logic as the Claude Code adapter.

```python
{
    "source_id": f"opencode:config:{project_id}:{config_type}",
    "timestamp": iso_now,
    "project_id": project_id,
    "project_path": project_path,
    "source_kind": "project_config_signal",
    "runtime": "opencode",
    "adapter_version": "1.0.0",
    "config_type": config_type,
    "file_path": relative_path,
    "signals": extracted_key_values
}
```

**Gap**: None. Filesystem-based extraction is runtime-agnostic.

---

## Source family availability

Summary of which corpus families the OpenCode adapter can produce:

| Family | Record types | Available? | Mechanism |
|--------|-------------|------------|-----------|
| Crystallized decisions | instruction_document | Yes | AGENTS.md files (global and project), instructions config |
| Decision history | history_prompt | Yes (CLI) | `opencode session list --format json` enumerates sessions; `opencode export [sessionID]` provides full message JSON for prompt extraction |
| Conversation exchanges | conversation_turn | Yes (CLI) | `opencode export [sessionID]` provides full session JSON with paired user-assistant turns |
| Config patterns | project_config_signal | Yes | Direct filesystem scan, identical to Claude Code |

**Initial port profilera mode**: Full. All four source families are available via included OpenCode functionality. Crystallized decisions come from AGENTS.md files and instructions config. Decision history and conversation exchanges come from `opencode export` CLI output. Config patterns come from direct filesystem scan.

---

## Installation

OpenCode discovers skills at `skills/*/SKILL.md` one level under its search directories. Because agentera's skills are nested inside `skills/*/SKILL.md` within the repo, cloning the whole repo into a search directory would place them two levels deep and OpenCode would not find them. Each skill must be linked individually.

### Global install (recommended)

```bash
# Symlink each skill directory into OpenCode's global skills directory
for skill in ~/git/agentera/skills/*/; do
  ln -s "$skill" ~/.config/opencode/skills/$(basename "$skill")
done
```

OpenCode discovers all 12 skills from `~/.config/opencode/skills/realisera/SKILL.md`, `~/.config/opencode/skills/inspektera/SKILL.md`, etc.

### Project install

```bash
# Symlink each skill into the project's .opencode/skills/ directory
for skill in /path/to/agentera/skills/*/; do
  ln -s "$skill" .opencode/skills/$(basename "$skill")
done
```

Or use `.agents/skills/` for the same effect (agent-compatible search path).

### Configuration

No `opencode.json` configuration is required. Skills are discovered and loaded automatically.

Optional: configure skill permissions if you want to gate certain skills:

```json
{
  "permission": {
    "skill": {
      "*": "allow"
    }
  }
}
```

### Hook plugin (optional)

For artifact validation and session continuity, install the agentera hook plugin:

```bash
cp .opencode/plugins/agentera.js ~/.config/opencode/plugins/
```

---

## Remaining gaps

| Gap | Impact | Mitigation |
|-----|--------|------------|
| Sub-agent dispatch lacks built-in worktree isolation | realisera/orkestrera run in same working tree | Strategy A (Task tool) for initial port; manual `git worktree` commands for full isolation |
| `opencode run --format json` event schema differs from `claude -p --output-format json` | Eval runner needs a separate JSON event parser | Implement an OpenCode-specific parser module in eval_skills.py; event stream structure is straightforward |
| Session history requires JSON event schema mapping | history_prompt and conversation_turn need export parser | `opencode export [sessionID]` provides full session JSON; adapter parses the export output |
| Python scripts require Python runtime | Hook plugin calls Python via shell | Python is already a prerequisite for agentera scripts |

---

## Validation

To verify the adapter is sufficient, check each acceptance criterion from PLAN.md Task 4:

1. **Each of the six host capabilities is mapped**: Yes. Skill discovery, artifact resolution, and profile path have direct OpenCode equivalents with no gaps. Sub-agent dispatch maps to the Task tool (with manual git worktree as an alternative). Eval mechanism maps to `opencode run --format json`. Hook lifecycle maps to the plugin event system.

2. **Session Corpus Contract is mapped per record type**: Yes. All four portable record types are mapped. instruction_document and project_config_signal have immediate extraction paths. history_prompt and conversation_turn are extractable via `opencode export` CLI output. The memory_entry Claude Code extension does not apply to OpenCode.

3. **A developer can implement OpenCode support without reading SKILL.md source**: Yes. This document specifies the adapter mapping, installation steps, extraction logic, and remaining gaps independently.

4. **Every required capability and normalized corpus source family is addressed**: Yes. All six capabilities and all five record types are addressed, with explicit availability status and implementation paths for each.
