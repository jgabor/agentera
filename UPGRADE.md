# Upgrading to Agentera v2

## What changed

- **12 standalone skills -> 1 bundled skill** with 12 capabilities under `skills/agentera/`
- **Artifact format**: Markdown -> YAML for agent-facing `.agentera/` files
- **Upgrade CLI**: `uvx --from git+https://github.com/jgabor/agentera agentera upgrade` or `uv run scripts/agentera upgrade` from a clone
- **State CLI**: `uv run scripts/agentera prime`, `uv run scripts/agentera state plan`, and other `state` namespace commands for routine access; `/agentera` still renders the hej dashboard from the `agentera prime` composite result, while `uv run scripts/agentera state query <artifact-name> --format json|yaml` remains advanced custom access. Top-level aliases such as `hej`, `plan`, and `query` remain during migration with stderr deprecation.

## Recommended upgrade

### No local clone

Use this path if you installed Agentera through `npx skills`, the Copilot
marketplace, the Codex marketplace, or the OpenCode plugin and do not have a
local clone.

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions without package-manager changes:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project /path/to/project --yes
```

Add `--update-packages` only when you explicitly want Agentera to run external
package-manager commands such as `npx skills remove` and `npx skills add`:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project /path/to/project --yes --update-packages
```

When the Python package is published, the shorter command is equivalent:

```bash
uvx agentera upgrade --project /path/to/project --dry-run
uvx agentera upgrade --project /path/to/project --yes
```

This command installs or refreshes the managed Agentera app under the Agentera
app home before it wires runtime config. Runtime config should not point at uv's
disposable tool cache.

`npx skills update` alone refreshes the visible skill files but does not refresh
Agentera's local app files, migrate project artifacts, clean up the old Agentera
directory, or rewrite runtime config. Agentera v2.0.2 keeps a legacy `/hej` bridge so
old entry points can hand users to the command above, but the command above is
the complete upgrade path. With explicit `--update-packages`, it removes
package-managed v1 skill entries and installs `/agentera`.

### App and runtime repair

`codex plugin marketplace upgrade`, `copilot plugin marketplace upgrade`, and
`npx skills update -g -y` refresh package-managed surfaces. They do not
guarantee that the app files under `AGENTERA_HOME/app` or managed runtime
surfaces have the latest Agentera wiring. Directory selection and read-only
repair checks are centralized in `scripts/install_root.py`.

Bare `/agentera` owns this recovery path. When the installed CLI is missing
`prime`, fails before command discovery, has an outdated `.agentera-bundle.json`
version, or otherwise fails the install status contract, it should show the
repair preview for the resolved Agentera directory. The preview covers app files,
managed runtime config, plugins, hooks, commands, and safe cleanup together. It
changes nothing:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --install-root "$AGENTERA_HOME" --dry-run
```

The durable location is still the Agentera directory, and app files are still
installed under `$AGENTERA_HOME/app`.

If the installed app gate cannot execute because `AGENTERA_HOME` names the old
`$HOME/.agents/agentera` directory and `$AGENTERA_HOME/app/scripts/agentera` is
missing, do not require a successful failed CLI invocation and do not first ask
the user to unset `AGENTERA_HOME`. Preview the normal Agentera directory repair path
without `--install-root` so upgrade can choose the normal platform directory and
preview cleanup of the old directory:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --dry-run
```

Only after explicit approval should it apply the same safe repair path:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --yes
```

Custom invalid `AGENTERA_HOME` values are different: choose a different Agentera
directory, or use `--force` only after checking that directory is safe to replace. Do
not describe the old default directory as proof of where the environment value came
from.

From a current local clone, inspect the same read-only self-check with:

```bash
uv run scripts/agentera doctor --install-root "$AGENTERA_HOME" --json
```

Only after explicit approval for that same app home should it apply:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --install-root "$AGENTERA_HOME" --yes
```

The apply command refreshes the managed app and managed runtime surfaces that the
preview proved Agentera owns. It does not run package updates unless
`--update-packages` is explicitly present.
Afterward, retry:

```bash
RESOLVED_AGENTERA_HOME="<app home reported by upgrade>"
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" prime
```

Set `RESOLVED_AGENTERA_HOME` before running the command. Never combine the
app-home assignment with the same shell command that expands the managed app
script path; shell expansion can otherwise turn an unset `AGENTERA_HOME` into
`/app/scripts/agentera` before the assignment takes effect.

If `AGENTERA_HOME` is unset, use the shared app-home contract's default platform
data home. If it points at a missing path, a file, or a directory with unrelated
files, Agentera stops instead of guessing. Choose a different Agentera directory,
or use `--force` only after checking that directory is safe to replace.

### Local clone

Preview first. This writes nothing and exits non-zero when pending work exists:

```bash
uv run scripts/agentera upgrade --project /path/to/project --dry-run
```

Apply local, idempotent upgrade actions:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes
```

The command migrates v1 project artifacts, installs or updates Agentera app
files when needed, configures selected runtime surfaces, removes fixable outdated
v1 runtime artifacts, and runs a final check. Re-running it after a successful
apply should report that nothing else needs to change.

`agentera upgrade` is the only repair command. When app files are version-behind,
the work inside that command is an **update**; when files are missing or broken,
it is a **repair**; when v1 project artifacts exist, it is a **migrate**. There
is no separate `agentera update` subcommand.

When `AGENTERA_HOME` is unset, Agentera uses the normal data directory for your
operating system. If the old `~/.agents/agentera` directory still contains Agentera
files, the preview says it will clean up that old directory, move known user data
into the selected Agentera directory, remove old app files, and delete
`~/.agents/agentera` when it becomes empty. The artifacts phase also migrates
supported v1 Markdown project artifacts such as `.agentera/PROGRESS.md`,
`.agentera/PLAN.md`, `.agentera/DOCS.md`, and root `VISION.md` into v2 YAML with
backups under `.agentera/backup-v1/` after preview and confirmation.

External package updates are deliberately opt-in because they run `npx` and may touch global runtime installs. The package phase removes legacy v1 skill entries and installs the active `/agentera` skill:

```bash
uv run scripts/agentera upgrade --project /path/to/project --yes --update-packages
```

## Runtime notes

### Claude Code

`agentera upgrade` does not require Claude access and does not run Claude smoke tests. Package refresh is skipped unless `--update-packages` is set.

### OpenCode

The upgrade command can copy the current bundled plugin to the OpenCode config directory and remove outdated v1 command files. The same adapter remains available as an npm-style package entry through `.opencode/package.json` `main`/`exports`, but the copied `~/.config/opencode/plugins/agentera.js` path remains preserved for project-local installs. OpenCode package refresh remains opt-in:

```bash
uv run scripts/agentera upgrade --runtime opencode --yes --update-packages
```

Use `--opencode-config-dir PATH` to target a non-default OpenCode config directory.

OpenCode compaction context is provided by `experimental.session.compacting`. The plugin appends bounded context from `agentera hej --format json` and does not read `.agentera` artifacts directly for that hook.

### Codex

The upgrade command writes `AGENTERA_HOME` into `~/.codex/config.toml` and manages Codex hook trust. When `[plugins."agentera@agentera"].enabled = true` proves the Agentera Codex plugin is installed and enabled, upgrade enables `[features].hooks`, `[features].plugin_hooks`, trusts the plugin-bundled hook metadata, and retires Agentera-owned copied `~/.codex/hooks.json` files. If copied hooks contain user or ambiguous entries, upgrade blocks for manual review instead of deleting them. Agentera v2 is one bundled `$agentera` skill; the old per-skill `[agents.<name>]` Codex config blocks are v1 artifacts and are not written.

When the Agentera Codex plugin is absent, disabled, or cannot be proven from `~/.codex/config.toml`, upgrade preserves the copied `~/.codex/hooks.json` compatibility fallback. Those copied hook commands use the resolved Agentera validator path, so they do not depend on hook subprocesses inheriting `[shell_environment_policy].set`.

```bash
uv run scripts/agentera upgrade --runtime codex --yes
```

### Copilot CLI

Upgrade does not edit shell startup files. Pass app context per invocation:

```bash
AGENTERA_HOME=/path/to/agentera copilot ...
```

To check for a leftover 1.x managed marker block in shell startup files, run the
diagnostic helper (read-only; changes nothing):

```bash
uv run scripts/setup_copilot.py --install-root /path/to/agentera
```

### Cursor

**Local plugin (no Marketplace listing required)**

Install from a clone or release checkout into Cursor's local plugin directory.
The plugin root must contain `.cursor-plugin/plugin.json`:

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
# or: ln -s /path/to/agentera ~/.cursor/plugins/local/agentera
```

Restart Cursor or run **Developer: Reload Window**. Agentera is not published to
the Cursor Marketplace yet.

The plugin loads skills, managed capability agents, and hooks. `sessionStart`
exports `AGENTERA_HOME` from the plugin checkout when the open project is not an
Agentera install root.

**Portable skill plus project upgrade**

Install the bundled skill with `npx skills add jgabor/agentera -g -a cursor --skill agentera -y`,
then install managed project surfaces:

```bash
uv run scripts/agentera upgrade --runtime cursor --dry-run
uv run scripts/agentera upgrade --runtime cursor --yes
uv run scripts/agentera doctor --runtime cursor
```

Use the plugin path for a user-global install. Use upgrade when you need
project-committed `.cursor/hooks.json` and `.cursor/agents/` copies (team
sharing, CI doctor checks, or working without the plugin). Both paths can be
combined.

Repo-native dogfood in this repository uses committed `.cursor/hooks.json` and
`.cursor/agents/*.md`. Upgrade copies those managed surfaces into other projects
with the same ownership protections used for OpenCode and Codex. Cloud agents are
unsupported in v1. Bare text `hej` routing stays metadata-only.

For CLI automation, eval coverage uses `cursor-agent` print mode:

```bash
uv run scripts/eval_skills.py --runtime cursor-agent --dry-run
```

See [`references/adapters/cursor.md`](references/adapters/cursor.md) for adapter details.

## Focused phases

Run one phase at a time when you want more control:

```bash
uv run scripts/agentera upgrade --only artifacts --project /path/to/project --yes
uv run scripts/agentera upgrade --only runtime --runtime codex --yes
uv run scripts/agentera upgrade --only cleanup --yes
uv run scripts/agentera upgrade --only packages --runtime opencode --yes --update-packages
```

## What's different in v2

| Aspect | v1 | v2 |
|---|---|---|
| Entry point | 12 separate `SKILL.md` files | `skills/agentera/SKILL.md` |
| Artifact format | Markdown | YAML |
| Upgrade path | Manual helper scripts | `uvx --from git+https://github.com/jgabor/agentera agentera upgrade` or `uv run scripts/agentera upgrade` |
| State CLI | none | `uv run scripts/agentera prime` as the dashboard data source, `state` namespace commands, plus advanced `uv run scripts/agentera state query <artifact-name> --format json` or `--format yaml` (top-level aliases remain during migration) |
| Validation | per-skill | `uv run scripts/agentera check validate capability <name-or-path>` plus `agentera check validate capability-contract` for schema self/protocol checks (top-level `validate` is a migration alias) |
| Shared primitives | `SPEC.md` | `skills/agentera/protocol.yaml` |
