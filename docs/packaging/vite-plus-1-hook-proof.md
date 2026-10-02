# Vite+ 1.0 formatting and pre-commit proof

Task 4, in `/home/jgabor/.local/share/orca/workspaces/agentera/vite-plus-1-toolchain`
on `vite-plus-1-toolchain`. No candidate commit, push, shared-hook activation,
shared Git configuration change, global tool modification or typed-state write
was performed. Prime retains lifecycle and integration ownership.

## Changes

- Root native staged policy runs fixes, then scoped readers inside the same
  hidden-partial-hunk snapshot. Native Vite+ is the sole hook owner.
- `.vite-hooks/pre-commit` supplies managed Node through the standalone launcher
  and invokes the worktree's local Vite+ tools. It removes local `.bin` entries
  from launcher discovery, so the dispatcher's PATH prefix cannot substitute a
  Node-dependent local shim for the standalone runtime owner.
- `run-lefthook.sh` supports only the existing `run pre-commit` entry point and
  forwards to native policy. No Lefthook parser, dependency or activation remains.
- Oxfmt owns eligible Markdown; separate Markdownlint routes/config/dependencies
  are removed. Width 320 agrees across root/package/editor settings. Explicit
  Markdown directory traversal preserves the existing exclusions.
- Dependency installation disables automatic hook activation. The root bootstrap
  wrapper keeps the frozen install but does not change shared hook configuration.
- Two documentation tests normalize Markdown table padding, while retaining the
  exact inventory counts, commands, field values and evidence assertions. Protocol,
  schema, retained-reference inventories and historical fixture bytes are unchanged.

See [the concession record](vite-plus-1-formatting-concessions.md) for the lost
Markdownlint rule inventory and formatting exceptions. Only eligible maintained
Markdown with concrete format drift was normalized; excluded protocol/state,
fixture/evidence, generated output and historical certification inputs were not.

Task 4 touched root formatter/editor/staged config, hook scripts and policy,
dependency manifests/lock, native-hook/formatter/baseline/table-contract tests,
current contributor guidance, and these internal packaging proof records.
Existing task 2/3 changes in overlapping files were retained. No source budget,
warning limit or test assertion was dropped.

Task 4 file inventory (including overlapping files and formatting-only changes):

```text
.editorconfig
.gitignore
.lefthook.yml (removed)
.markdownlint.json (removed)
.markdownlintignore (removed)
.vite-hooks/pre-commit (new, executable)
vite.config.ts
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
packages/cli/scripts/pre-commit-checks.mjs (new)
packages/cli/scripts/run-lefthook.sh
packages/cli/scripts/verify-hook-bootstrap.mjs
references/analysis/verification-policy.yaml
packages/cli/test/scripts/nativeHooks.test.ts
packages/cli/test/config/formatterSurface.test.ts
packages/cli/test/validate/toolchainBaseline.test.ts
packages/cli/test/verification/laneOwnership.test.ts
packages/cli/test/cli/coverageContract.test.ts
AGENTS.md
.opencode/skills/agentera-state/SKILL.md
.opencode/skills/agentera-verification/SKILL.md
packages/cli/README.md
packages/cli/test/README.md
docs/README.md
docs/cli-coverage-contract.md
docs/verification-performance.md
docs/packaging/v3-packaging.md
docs/packaging/vite-plus-1-baseline.md
docs/packaging/vite-plus-1-runtime-proof.md
docs/packaging/vite-plus-1-toolchain-review.md
docs/packaging/vite-plus-1-formatting-concessions.md (new)
docs/packaging/vite-plus-1-hook-proof.md (new)
```

## Verification

Runtime: standalone and local Vite+ 1.0.0, managed Node 24.19.0, pnpm 10.30.3,
aligned Vite alias, Vitest 5.0.1, Oxfmt 0.70.0 and Oxlint 1.85.0.

The final targeted command was:

```bash
vp test run \
  packages/cli/test/scripts/nativeHooks.test.ts \
  packages/cli/test/config/formatterSurface.test.ts \
  packages/cli/test/config/vitestShared.test.ts \
  packages/cli/test/validate/toolchainBaseline.test.ts \
  packages/cli/test/verification/laneOwnership.test.ts \
  packages/cli/test/cli/coverageContract.test.ts \
  --reporter=json --outputFile=/tmp/opencode/agentera-task4-targeted-final.json
```

The JSON report was independently checked: **137 passed, zero failed, zero
pending**. Coverage includes native owner discovery, related/local boundaries,
unusual and option-like filenames, renames/deletions, partial hunks and byte
exclusions, old-entry compatibility, and actual installed-hook guard/related/
typecheck failures with stash/index/worktree restoration. Compact and parity
selection plus ordered success/failure propagation use deterministic command
fixtures; their engines were not changed.

Other completed checks:

- `VP_GIT_HOOKS=0 vp install --frozen-lockfile`: pass, authoritative lock up to date.
- `vp check`: pass, 831 formatted files; zero lint errors and the same six
  pre-existing warnings, below the unchanged limit of eight.
- Final `vp fmt --check` including this proof record: pass, 831 files.
- `vp run typecheck`: pass.
- `vp run build`: pass, current local build and extraction parity synchronized.
- `vp node packages/cli/dist/bin/agentera.js check validate retained-references`:
  pass, retained reference authority unchanged.
- `vp node packages/cli/dist/bin/agentera.js check compact`: pass, zero repairs or
  changed artifacts. Writer-owned canonical entities were skipped, not formatted.
- `vp exec bash packages/cli/scripts/py_ts_parity.sh --check --json`: pass, no drift.
- `git diff --check`: pass.
- `git diff --exit-code -- .github/workflows/publish.yml`: pass, untouched.

## Disposable native activation

```bash
vp node packages/cli/scripts/verify-hook-bootstrap.mjs /bin/vp
```

Final result: **pass**, receipt at
`/tmp/opencode/agentera-hook-bootstrap-MCZ73U/receipt.json`.
The proof creates only an independent repository under `/tmp/opencode`, with
private HOME/config/cache and OS-only PATH. It provisions the pinned runtime and
dependencies, checks a frozen reinstall, enables the native dispatcher locally,
then exercises ordinary Git, current-root execution, staged-hunk formatting,
related/guard selection and managed typecheck. It proves failures for missing
dependencies, missing standalone launcher, and missing launcher even with an
ambient Node available. Unrelated local config and private global config remain
unchanged. No checkout clone, worktree or real shared-hook activation is needed.

Early harness probes caught existing-foreign-hooksPath behavior, the dispatcher's
`basename` prerequisite, local-shim shadowing, and table padding assertions. They
were corrected before the final passes, without dropping their assertions.
Two later cold acquisitions failed with OS `EDQUOT` while writing Node, confirmed
by a narrow `strace` probe. Removing only runtime/dependency caches from this
worker's failed disposable proofs freed quota; the final fresh proof above passed.
Failure receipts remain in `agentera-hook-bootstrap-enaAMk` and
`agentera-hook-bootstrap-0vWFyZ` under `/tmp/opencode`. This was not hidden or
worked around with an ambient runtime.

## Shared boundary and remaining limits

Before/after SHA-256 values are identical:

```text
7b7b4c3dd088f2e25b273f435555d661c833217c2b2ac95d948cc10e16d26f6c  /home/jgabor/git/agentera/.git/config
99aa8c1f206bf72ed7a29e314f93bf52b3bf3ee217fb9853aa1f02313ddaa927  /home/jgabor/git/agentera/.git/hooks/pre-commit
```

The checkout still has no `core.hooksPath` override. Its existing common hook
continues to use the compatibility entry point. The proof does not authorize
Prime's shared-hook replacement or activation.

Hooks are bypassable local quality checks, not a security boundary. The upstream
native dispatcher can skip policy if `basename` is missing or a foreign hook path
prevents activation; setup must inspect status and supply OS prerequisites.
Actual editor integration was not exercised beyond the shared root config/width
contract. Maintainer skill guidance needs an OpenCode restart to reload.
Full source/release qualification, hosted CI, package-cost work, task caching and
CI comparison were not run here and remain with their assigned owners.
