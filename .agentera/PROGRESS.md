# Progress

■ ## Cycle 162 · 2026-04-26 06:35 · feat(validator): accept arbitrary SKILL.md paths for third-party authoring

**What**: Spec validator now takes `--skill PATH` (repeatable). External skill authors can run `python3 scripts/validate_spec.py --skill path/to/SKILL.md` against SPEC.md without forking the repo. Default glob over the canonical 12 stays unchanged.
**Commit**: 121e40f feat(validator): accept arbitrary SKILL.md paths for third-party authoring
**Inspiration**: Vision direction names third-party skills building against the spec. Analytics flagged 12/12 prior cycles drew on external inspiration and asked for original design grounded in the project's own vision.
**Discovered**: `check_cross_skill_integration` already handled unknown skill names gracefully via `REQUIRED_REFS.get(skill, [])`, so no bypass logic was needed. CLAUDE.md turned out to be a symlink to AGENTS.md, which is the canonical file.
**Verified**: `python3 scripts/validate_spec.py --skill skills/realisera/SKILL.md` exited 0 and printed `Results: 0 error(s), 0 warning(s) across 1 skills`. `python3 scripts/validate_spec.py --skill /tmp/nonexistent/SKILL.md` exited 1 with `ERROR: SKILL.md not found: /tmp/nonexistent/SKILL.md`. `python3 scripts/validate_spec.py --help` rendered the new flag with third-party authoring context. Default `python3 scripts/validate_spec.py` still reported 0 errors and 0 warnings across 12 skills. `python3 -m pytest -q` returned 363 passed (was 361 before, +2 new TestMainSkillFlag tests). `python3 scripts/validate_lifecycle_adapters.py` returned `lifecycle adapter metadata ok`. `git diff --check` was clean.
**Next**: Apply DOCS.md `feat = minor` policy and bump suite metadata from 1.18.1 to 1.19.0. This cycle deferred the bump to keep scope on the validator surface.
**Context**: intent (open the spec validator to third-party skill authors) · constraints (preserve default behavior, two-test budget, no version bump this cycle, no worktree dispatch) · unknowns (whether external authors will need `twelve-skill suite` phrasing softened later) · scope (`scripts/validate_spec.py`, `tests/test_validate_spec.py`, `AGENTS.md`).

■ ## Cycle 161 · 2026-04-25 18:55 · chore(plan): checkpoint copilot marketplace freshness

**What**: Completed Task 7 only. Closed the canonical Copilot marketplace plan with a compact state refresh across plan, progress, TODO, and changelog evidence.
**Commit**: chore(plan): checkpoint copilot marketplace freshness
**Inspiration**: Tasks 1-6 all passed while preserving the evidence boundary: no canonical Agentera Copilot marketplace source is verified.
**Discovered**: CHANGELOG [Unreleased] already had one caveated marketplace-support entry and one validation-guard entry; no public availability claim needed removal.
**Verified**: Progress acceptance is satisfied by this cycle's plan-level outcome summary: README treats `copilot plugin install <plugin>@<marketplace>` as syntax only, records built-in Copilot marketplaces `copilot-plugins` and `awesome-copilot` with no `agentera`, labels legacy per-skill entries, records `/skills list` omissions for `hej`, `inspektera`, and `profilera`, and keeps lifecycle support partial. TODO acceptance is satisfied by one open deferred item for future canonical marketplace publication plus a resolved Task 7 checkpoint item. Changelog acceptance is satisfied by [Unreleased] representing marketplace support/caveats once and validation guards once, without duplicate marketplace availability claims. `python3 scripts/validate_spec.py` and `git diff --check` passed.
**Next**: Publish or verify a canonical Agentera Copilot marketplace source before changing syntax-only guidance into an availability claim.
**Context**: intent (Task 7 freshness checkpoint only) · constraints (no README, validation, version, or marketplace semantics changes; commit but do not push) · unknowns (future canonical marketplace source) · scope (`CHANGELOG.md`, `TODO.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 160 · 2026-04-25 18:40 · docs(release): apply copilot release convention

**What**: Completed Task 6 only. Applied DOCS.md version policy to the Copilot marketplace work and tightened release-note caveats without bumping metadata.
**Commit**: docs(release): apply copilot release convention
**Inspiration**: Task 5 evidence: no canonical Agentera Copilot marketplace source is verified, so user guidance changed but install support did not gain a new verified capability.
**Discovered**: CHANGELOG [Unreleased] represented the validation work but one marketplace guidance line needed the no-verified-source caveat to avoid implying availability.
**Verified**: DOCS.md version policy says `feat = minor`, `fix = patch`, and `docs/chore/test = no bump`; current marketplace work produced docs/test/chore changes and no verified new install capability, so no version files were bumped. CHANGELOG [Unreleased] now says Copilot marketplace-style installs are preferred only when a verified source exists, states no canonical Agentera Copilot marketplace source is currently verified, and keeps direct repo installs as deprecated fallback paths. `python3 scripts/validate_spec.py` and `git diff --check` passed.
**Next**: Task 7 remains pending for the plan-level freshness checkpoint; do not run it as part of Task 6.
**Context**: intent (apply release convention only) · constraints (no Task 7 sweep, no invented marketplace source, no unnecessary version bump, commit but do not push) · unknowns (future canonical Agentera Copilot marketplace source) · scope (`CHANGELOG.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 159 · 2026-04-25 18:24 · docs(copilot): update user guidance

**What**: Completed Task 5 only. README now keeps Copilot marketplace guidance evidence-gated, records the verified no-source limitation, and tightens lifecycle language around partial support.
**Commit**: 1f006a8 docs(copilot): update user guidance
**Inspiration**: Task 4 host evidence: no verified marketplace source, aggregate installed state, legacy per-skill entries, and `/skills list` omission of some installed skills.
**Discovered**: The install guidance already avoided an invented source, but it lacked the concise host discrepancy note users need when comparing `copilot plugin list` with `/skills list`.
**Verified**: README uses `copilot plugin install <plugin>@<marketplace>` only as syntax and states no canonical Agentera Copilot marketplace source is verified; it cites observed built-in marketplaces `copilot-plugins` and `awesome-copilot` with no `agentera` entry; it preserves aggregate `agentera` install guidance, labels older per-skill entries as legacy, records `/skills list` omitting installed `hej`, `inspektera`, and `profilera`, and keeps Copilot lifecycle support partial without claiming Claude hook parity. `python3 -m pytest tests/test_runtime_adapters.py::TestCopilotPackaging::test_copilot_readme_install_guidance_passes -q`, `python3 scripts/validate_spec.py`, and `git diff --check -- README.md .agentera/PLAN.md .agentera/PROGRESS.md` passed.
**Next**: Task 6 may later decide whether DOCS.md version policy requires a release update; Task 6 and Task 7 were not executed here.
**Context**: intent (update Task 5 user guidance only) · constraints (no invented marketplace source, no canonical path, preserve aggregate model and profilera caveats, no version bump) · unknowns (future canonical Agentera Copilot marketplace source, reason for host skill-discovery omissions) · scope (`README.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 158 · 2026-04-25 17:53 · chore(runtime): verify copilot host state

**What**: Completed Task 4 only. Read-only Copilot checks preserved the no-verified-source branch and recorded installed-state discrepancies without making marketplace availability claims.
**Commit**: 2f154c2 chore(runtime): record copilot host verification
**Inspiration**: Task 1 through Task 3 evidence: Copilot has built-in marketplaces, README keeps placeholder syntax non-claiming, and validation rejects unverified marketplace claims.
**Discovered**: Existing host state includes aggregate `agentera (v1.18.1)` plus legacy per-skill `@agentera` installs. `/skills list` showed several Agentera skills but omitted installed `hej`, `inspektera`, and `profilera`.
**Verified**: No marketplace install smoke ran because no canonical Agentera Copilot marketplace path is verified. Read-only checks: `copilot --version` -> `GitHub Copilot CLI 1.0.35`; `copilot plugin marketplace list` -> `copilot-plugins` and `awesome-copilot`; browsing both catalogs showed no `agentera` entry; `copilot plugin list` showed aggregate `agentera (v1.18.1)` and legacy per-skill entries only; `copilot -p "/skills list" --no-custom-instructions --no-auto-update --output-format text` exited 0 and listed Agentera skills from existing host state while omitting installed `hej`, `inspektera`, and `profilera`.
**Next**: Task 5 may update user guidance later, but only from this recorded no-verified-source evidence unless a canonical marketplace path is separately verified.
**Context**: intent (verify host behavior for Task 4 without inventing a source) · constraints (read-only checks only, no installs, no Task 5 guidance, no version bump) · unknowns (future canonical Agentera marketplace path, host skill-list omission cause) · scope (`.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 157 · 2026-04-25 18:10 · test(install): guard copilot marketplace claims

**What**: Completed Task 3 final retry only. README Copilot install guidance validation now blocks additive contradictory marketplace and fallback claims without changing README semantics.
**Commit**: 1af096c test(install): guard copilot marketplace claims; 2aaa3ab docs(progress): log marketplace claim guards; db38bad docs(progress): correct marketplace guard evidence; 4ca5232 test(install): reject contradictory copilot guidance
**Inspiration**: Task 1 and Task 2 evidence: Copilot has built-in marketplaces, but no canonical Agentera Copilot marketplace source is verified.
**Discovered**: The previous guard still allowed additive text saying Agentera is available from the Copilot marketplace and additive text promoting `OWNER/REPO` as the primary install path.
**Verified**: `python3 -m pytest tests/test_runtime_adapters.py::TestCopilotPackaging -q` -> 7 passed, covering one README pass plus fail tests for additive unavailable marketplace claims, placeholder syntax masquerading as `agentera@<marketplace>`, and additive primary fallback wording. `python3 -m pytest -q` -> 361 passed. `python3 scripts/validate_spec.py` -> 0 errors, 0 warnings. `git diff --check` -> no output.
**Next**: Task 4 can run later if a verified host-behavior scope is still needed; no live host smoke docs, version bumps, or plan-level freshness work ran here.
**Context**: intent (guard public Copilot install guidance from unsupported marketplace claims) · constraints (Task 3 only, no invented sources, preserve README semantics, proportional tests) · unknowns (future canonical Agentera marketplace source) · scope (`tests/test_runtime_adapters.py`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 156 · 2026-04-25 18:02 · docs(install): clarify copilot marketplace placeholder

**What**: Completed Task 2 only. README now treats Copilot `<plugin>@<marketplace>` as marketplace syntax, not proof that Agentera is published there.
**Commit**: ee62888 docs(install): clarify copilot marketplace placeholder; 0dedcaa test(install): accept copilot marketplace placeholder
**Inspiration**: Task 1 evidence: Copilot CLI 1.0.35, built-in marketplaces `copilot-plugins` and `awesome-copilot`, and no `agentera` entry in browsed catalogs.
**Discovered**: The README Copilot command and runtime table could be read as a concrete availability claim even though the plan evidence says no canonical Agentera marketplace source is verified.
**Verified**: README says no Agentera Copilot marketplace source is currently verified, uses `copilot plugin install <plugin>@<marketplace>` as syntax only, preserves future aggregate `agentera` plugin language for the verified-source branch, and keeps `OWNER/REPO`, `OWNER/REPO:PATH`, Git URL, and local path installs as deprecated fallback paths. Remediation reran `python3 -m pytest tests/test_runtime_adapters.py::TestCopilotPackaging::test_copilot_readme_install_guidance_passes tests/test_runtime_adapters.py::TestCopilotPackaging::test_copilot_readme_install_guidance_fails_without_marketplace_first -q` -> 2 passed, `python3 -m pytest -q` -> 359 passed, `python3 scripts/validate_spec.py` -> 0 errors, 0 warnings, and `git diff --check` -> no output. Operational evidence correction verified this cycle now records both Task 2 commits: `ee62888` and `0dedcaa`.
**Next**: Task 3 may add validation guards later; no validation rules, host smoke docs, version bumps, or plan-level freshness work were done in this cycle.
**Context**: intent (align install surface without inventing a marketplace source) · constraints (Task 2 only, preserve profilera caveats, direct installs secondary) · unknowns (future canonical Copilot marketplace source) · scope (`README.md`, `.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 155 · 2026-04-25 17:32 · docs(plan): record copilot marketplace evidence

**What**: Completed Task 1 only. PLAN now records the verified Copilot marketplace identities and the absence of a canonical Agentera source.
**Commit**: b2fe57b docs(plan): record copilot marketplace evidence
**Inspiration**: Active evidence-gated plan and Copilot host marketplace commands.
**Discovered**: Copilot CLI exposes built-in marketplaces `copilot-plugins` and `awesome-copilot`; neither browsed catalog showed an `agentera` plugin.
**Verified**: `copilot --version` -> `GitHub Copilot CLI 1.0.35`; `copilot plugin marketplace list` -> built-ins `copilot-plugins (GitHub: github/copilot-plugins)` and `awesome-copilot (GitHub: github/awesome-copilot)`; `copilot plugin marketplace browse copilot-plugins` -> `workiq`, `spark`, `advanced-security`; `copilot plugin marketplace browse awesome-copilot` returned a catalog with no `agentera` entry. Therefore no canonical Agentera marketplace source is verified, and no availability claim was added.
**Next**: Task 2 can align install surface while preserving the no-verified-source branch.
**Context**: intent (establish repeatable marketplace evidence) · constraints (Task 1 only, no README or validation changes, no invented sources) · unknowns (whether Agentera will later be published to a Copilot marketplace) · scope (`.agentera/PLAN.md`, `.agentera/PROGRESS.md`).

■ ## Cycle 154 · 2026-04-25 16:10 · docs(copilot): prefer marketplace plugin installs

**What**: Completed the Copilot marketplace guidance plan. README now leads with `plugin@marketplace`, keeps direct installs as deprecated fallback, and explains aggregate versus legacy installed plugin entries.
**Commit**: d69e069 docs(copilot): prefer marketplace plugin installs
**Inspiration**: Copilot CLI warning during direct `jgabor/agentera` install plus the inspirera cross-pollination analysis.
**Discovered**: Copilot has built-in marketplaces available, while local plugin state can show both aggregate `agentera` and older per-skill `@agentera` entries.
**Verified**: `python3 -m pytest tests/test_runtime_adapters.py -q` -> 24 passed. `python3 -m pytest -q` -> 359 passed. `python3 scripts/validate_spec.py` -> 0 errors, 0 warnings. `copilot plugin marketplace list` showed `copilot-plugins` and `awesome-copilot`; `copilot plugin list` showed aggregate `agentera (v1.18.1)` plus older per-skill entries.
**Next**: Publish or add an actual Agentera Copilot marketplace source when the canonical source is available.
**Context**: intent (make Copilot install docs marketplace-first) · constraints (no invented marketplace name, keep partial hook caveat, direct fallback stays) · unknowns (canonical Agentera marketplace source not verified) · scope (`README.md`, adapter tests, state artifacts).

■ ## Cycle 153 · 2026-04-25 15:23 · fix(copilot): load skills from checkout plugin root

**What**: Completed the Copilot packaging fix. Current-checkout loading now uses root `plugin.json`, so Copilot sees shared `skills/` inside the plugin root.
**Commit**: f628cc1 fix(copilot): load skills from checkout plugin root
**Inspiration**: Cycle 152 live smoke found `skills path escapes plugin directory: ../../skills`.
**Discovered**: Copilot accepts a repo-root plugin manifest with `skills: "skills"` and `hooks: ".github/hooks"`, avoiding duplicated skill files while preserving `skills/<name>/SKILL.md` as source of truth.
**Verified**: `copilot --config-dir /tmp/agentera-copilot-smoke --plugin-dir $HOME/git/agentera -p "/skills list" --no-custom-instructions --no-auto-update --output-format text` exited 0 and listed 12 agentera skills. `python3 scripts/validate_lifecycle_adapters.py` -> `lifecycle adapter metadata ok`. `python3 -m pytest tests/test_runtime_adapters.py -q` -> 22 passed. `python3 -m pytest -q` -> 357 passed. `python3 scripts/validate_spec.py` -> 0 errors, 16 baseline warnings. Artifact validation and `git diff --check` passed.
**Next**: Run a follow-up health check if you want Audit 12 updated to reflect the closed Copilot current-checkout caveat.
**Context**: intent (fix Copilot current-checkout packaging) · constraints (no duplicate skill source, no dependencies, live smoke required) · unknowns (marketplace install behavior still uses installed plugin path) · scope (`plugin.json`, Copilot validators/tests, README, state artifacts).

## Archived Cycles

- Cycle 152 (2026-04-25): chore(runtime): smoke live Copilot and Codex hosts
- Cycle 151 (2026-04-25): chore(plan): checkpoint Audit 11 freshness
- Cycle 150 (2026-04-25): chore(release): bump suite to 1.18.1
- Cycle 149 (2026-04-25): test(profilera): deepen corpus validation fixtures
- Cycle 148 (2026-04-25): refactor(profilera): localize corpus runtime orchestration
- Cycle 147 (2026-04-25): fix(adapters): repair OpenCode path and hook drift
- Cycle 146 (2026-04-25): fix(adapters): catch Codex invocation hint drift
- Cycle 145 (2026-04-25): fix(adapters): tighten runtime metadata drift guards
- Cycle 144 (2026-04-25): fix(profilera): redact Copilot config secrets
- Cycle 143 (2026-04-25): fix(profilera): align Section 21 corpus record envelope
- Cycle 142 (2026-04-24): chore(plan): checkpoint runtime portability freshness
- Cycle 141 (2026-04-24): chore(release): bump suite to 1.18.0
- Cycle 140 (2026-04-24): test(profilera): integrate multi-runtime status validation
- Cycle 139 (2026-04-24): evidence(profilera): verify Codex extraction entrypoint
- Cycle 138 (2026-04-24): feat(profilera): collect Codex corpus records
- Cycle 137 (2026-04-24): feat(profilera): collect Copilot corpus records
- Cycle 136 (2026-04-24): fix(adapters): repair Codex and OpenCode metadata
- Cycle 135 (2026-04-24): fix(adapters): repair Claude and Copilot metadata
- Cycle 134 (2026-04-23): chore(plan): checkpoint Copilot and Codex native loading freshness
- Cycle 133 (2026-04-23): chore(release): verify 1.17.0 version bump evidence
- Cycle 132 (2026-04-23): test(adapters): cover runtime adapter metadata
- Cycle 131 (2026-04-23): feat(hooks): add lifecycle adapter strategy
- Cycle 130 (2026-04-23): chore(codex): place safeguards on per-skill metadata
- Cycle 129 (2026-04-23): chore(codex): add skill presentation safeguards
- Cycle 128 (2026-04-23): fix(realisera): address review findings
- Cycle 127 (2026-04-23): refactor(hooks): dedup DOCS.md parsing and close gitignore discrepancy
- Cycle 126 (2026-04-23): docs(realisera,optimera): add stale-base awareness to dispatch step
- Cycle 125 (2026-04-23): refactor(hooks): split _format_todo_oneline into per-step helpers
- Cycle 124 (2026-04-23): chore(release): bump version to 1.16.0
- Cycle 123 (2026-04-23): refactor(artifacts): restore header-regex match against current SPEC format
- Cycle 122 (2026-04-23): Added `.opencode/package.json` ESM type and removed seven unused plugin bindings while preserving session.created, tool.execute.after, and session.idle hook behavior.
- Cycle 121 (2026-04-23): feat(opencode): bootstrap slash commands from plugin into user config
- Cycle 120 (2026-04-23): Replaced legacy profile-path references with `$PROFILERA_PROFILE_DIR/PROFILE.md` across SPEC, consumer skills, docs, README, adapter docs, and contracts.
- Cycle 119 (2026-04-21): Operationalized SPEC Section 4 compaction with shared engine, CLI wrapper, hook nudge, tests, and producer skill instructions.
- Cycle 118 (2026-04-20): Version bump 1.13.0 to 1.14.0 per DOCS.md semver_policy (feat = minor). Updated all 14 version_files. Promoted CHANGELOG.md [Unreleased] to [1.14.0]....
- Cycle 117 (2026-04-13): Plan-level freshness checkpoint for Pre-dispatch Commit Gate plan (7 tasks, all complete). The plan delivered SPEC.md Section 22 (pre-dispatch commit...
- Cycle 116 (2026-04-13): Version bump 1.12.0 to 1.13.0 per DOCS.md semver_policy (feat = minor). Updated all 12 plugin.json files, registry.json (12 skill entries),...
- Cycle 115 (2026-04-13): Added tests for Check 19 (pre-dispatch-commit-gate) in `tests/test_validate_spec.py`. Three tests following the Check 17 proportionality pattern: 1 pass (both realisera...
- Cycle 114 (2026-04-13): Added Check 19 (pre-dispatch-commit-gate) to `scripts/validate_spec.py`. For skills in `WORKTREE_DISPATCH_SKILLS` (realisera, optimera), the check verifies four gate procedure indicators: Section...
- Cycle 113 (2026-04-13): Added pre-dispatch commit gate to optimera Step 4 (Implement) per SPEC.md Section 22. The gate checks working tree status, stages...
