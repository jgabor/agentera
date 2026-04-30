# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions are referenced by realisera, optimera, and profilera for context on why choices were made.

## Decision 29 · 2026-04-11

**Question**: How should optimera handle measurement archetypes that go beyond thin command-wrapper harnesses, and what should the first such reference look like?
**Context**: A /inspirera analysis of leda's benchmark suite proposed shipping `scripts/benchmark_skill.sh` at agentera's repo root plus a thin `.optimera/harness` wrapper (leda's own pattern). Two things didn't sit right: (1) that shape imposes leda-style infrastructure where optimera's philosophy says the harness is bespoke per project, and (2) a sketched `--repo-size` flag encodes fake precision because users can mislabel the target. A broader question surfaced — should optimera's brainstorm route to archetypes explicitly, or keep its conversation-driven model? Optimera's existing reference library (`test-pass-rate.md`, `bundle-size.md`, `coverage.md`, `lint-score.md`, `benchmark.md`) covers only thin-wrapper archetypes; nothing in it describes measuring agent behavior under controlled conditions.
**Alternatives**:

- Ship `scripts/benchmark_skill.sh` at repo root with a thin harness wrapper: rejected, doesn't match optimera's bespoke-per-project philosophy
- Ship composable Python primitives under `skills/optimera/scripts/primitives/`: rejected, over-engineering and creates a runtime install-path dependency
- Add an explicit archetype-routing substep to optimera's brainstorm: rejected, imposes taxonomy on a conversation that already adapts to user answers
- Single broad `session-telemetry.md` covering any session-level metric: rejected in favor of a split that factors machinery from the specific metric
- Single narrow `session-token-consumption.md` only: rejected, misses the chance to reuse vehicle machinery for future session-metric archetypes (wall-time, cost, tool-call counts)
**Choice**: Expand optimera's reference library with two new files. A machinery reference at `skills/optimera/references/agent-session-harness.md` (alongside `harness-guide.md`, not in `examples/`) describes running an agent under hermetic, reproducible conditions: two-condition A/B runs, stream-JSON telemetry parsing, causal plus numeric gates, per-run artifact layout, runtime-measured repo size. Docker is presented as one realization of "hermetic vehicle," not as a mandate. A metric-specific example at `skills/optimera/references/examples/session-token-consumption.md` applies the machinery to sum input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens across assistant messages, with optional per-artifact attribution via a container-scoped PostToolUse hook. No changes to optimera's SKILL.md workflow. No repo-root scripts. No primitives infrastructure. The actual `.optimera/harness` for agentera's skill-token case gets brainstormed by /optimera when invoked, not pre-baked in this deliberation.
**Reasoning**: Optimera's brainstorm is already user-driven: users describe what they want to measure and the skill adapts, drawing on references silently as pattern material. The gap isn't process structure; it's that the reference library has no material for measurement styles needing real infrastructure. Expanding the library is the minimal change that closes the gap without introducing workflow ceremony. Splitting machinery from metric-specific example keeps the two concerns separate so future session-metric archetypes can reuse the vehicle without duplicating it. The `--repo-size` flag dissolves: a bespoke harness takes `TARGET_REPO=<path>`, measures size at runtime (bytes, file count, `.agentera/` artifact tokens), and records in the meta file — no user label to get wrong. Not pre-baking agentera's harness is deliberate: invoking /optimera to produce it validates that the new reference actually guides the brainstorm, which is how we'll know the reference is good.
**Confidence**: provisional
**Feeds into**: `skills/optimera/references/` (expansion), standalone

## Decision 30 · 2026-04-12

**Question**: How should the realisera-token harness be redesigned after three consecutive discarded experiments where run-to-run variance (13-20%) drowned the optimization signal (5-10%)?
**Context**: Experiments 1-3 all measured the full-cycle composite (peak_context + output_total) via a single Docker A/B run. The composite conflates fixed cost (SKILL.md in the system prompt) and variable cost (which files the model reads, tool choice non-determinism). SKILL.md edits change the fixed cost deterministically, but the metric can't detect them because the variable cost swings 10-15K tokens between runs with identical code. The hej-token objective succeeded (29.5% signal vs 5% noise) because hej's session is short and deterministic; realisera's session is long and stochastic. A pre-flight token probe was built but couldn't isolate SKILL.md tokens via the CLI due to prompt caching. An API key is available for the Anthropic count_tokens endpoint.
**Alternatives**:

- Multi-run averaging (3x full Docker A/B, average composite): brute force, $9/experiment, reduces variance to ~5-7% but doesn't separate fixed from variable cost
- Tighter vehicle constraints (restrict tool surface further, deterministic file order): attacks variance at the source but reduces measurement realism
- Two-tier metric with Tier 2 composite as primary: keeps the noisy metric as the decision criterion, just adds Tier 1 as diagnostic
**Choice**: Two-tier metric. Tier 1 (primary): exact token count of SKILL.md + contract.md via the Anthropic count_tokens API (free, zero variance, deterministic). Tier 2 (behavioral validation): single Docker A/B run, pass bar is gates-only (causal + structural must pass), composite value is diagnostic only. An experiment is kept when Tier 1 improves AND Tier 2 gates pass.
**Reasoning**: The fixed cost (system prompt tokens) is exactly what SKILL.md edits control, and it's measurable with zero variance via the API. The variable cost (runtime reads, tool selection) is stochastic and outside the optimization scope of SKILL.md changes. Separating them means SKILL.md experiments get instant, exact feedback (Tier 1) while behavioral soundness is confirmed without requiring the noisy composite to improve (Tier 2). The full composite remains in the breakdown as a diagnostic for trend analysis across experiments. This unblocks contract.md lazy-reference, spec_sections trimming, and progressive disclosure experiments that were all stuck because the composite couldn't detect 5-10% improvements.
**Confidence**: firm
**Feeds into**: OBJECTIVE.md (metric redefinition), .optimera/harness (redesign)

## Decision 31 · 2026-04-12

**Question**: How should optimera represent multiple objectives, and should `.optimera/` consolidate under `.agentera/`?
**Context**: Today optimera pins a single OBJECTIVE.md / EXPERIMENTS.md / `.optimera/harness`. Rotating targets (hej-token to realisera-token) requires hand-written archive moves. `.optimera/` lives outside `.agentera/`, splitting artifact roots. Decision 4 established single-root artifact resolution via `.agentera/DOCS.md`.
**Alternatives**:

- Flat files + registry: keep OBJECTIVE.md/EXPERIMENTS.md in `.agentera/`, add a registry file with an active pointer. More machinery, single-objective illusion.
- Active symlink: named subdirs with a symlink marking the active one. Cross-platform fragility.
- Named subdirs, self-contained: one directory per objective under `.agentera/optimera/`, each containing OBJECTIVE.md, EXPERIMENTS.md, harness, helpers, vehicle/, runs/. No registry, no symlinks. Directory existence is the registry.
**Choice**: Named subdirs under `.agentera/optimera/`. Each objective is fully self-contained (helpers duplicated per-objective, no shared dir). Active objective inferred from context: single objective = use it, multiple = most recent activity, ambiguous = ask. DOCS.md drops OBJECTIVE.md/EXPERIMENTS.md from artifact mapping (optimera owns its own path resolution). One-shot migration of existing hej-token and realisera-token data.
**Reasoning**: Convention over configuration. The directory structure IS the multi-objective representation. Self-contained objectives are independently archivable, independently measurable, and require zero coordination. Single root under `.agentera/` aligns with Decision 4. Dropping DOCS.md mapping is correct because OBJECTIVE.md/EXPERIMENTS.md are no longer at fixed paths.
**Confidence**: firm
**Feeds into**: TODO.md (implementation), optimera SKILL.md (path changes), DOCS.md (mapping update), .gitignore (path update)

## Decision 32 · 2026-04-26

**Question**: How should agentera observe its own usage across host runtimes and feed adoption signal back into the suite?
**Context**: Profilera mines Claude Code, OpenCode, Copilot, and Codex sessions into a Section 21 corpus envelope (Decision 27). The corpus is consumed only by PROFILE.md generation. Agentera ships no mechanism to ask "how is the suite being used?": adoption stats, completion ratios, slash-vs-NL trigger reliability.
**Alternatives**:

- One-off diagnostic script: cheap, throw-away; no recurring value.
- New skill (e.g. /telemetera): full lifecycle, heavy for descriptive analytics.
- Reusable script under scripts/: re-runnable, no SKILL.md ceremony, can grow into a skill later.
**Choice**: `scripts/usage_stats.py` reading the existing Section 21 corpus. Detects invocations via skill workflow markers (`─── <glyph> <skill> · <phase> ───`) in assistant turns. Pairs each marker with its matching exit signal to count completed workflows; orphans count as incomplete. Tags each invocation slash-vs-NL by inspecting the prior user turn. Cross-project default with `--project PATH` to scope. Writes markdown to `~/.local/share/agentera/USAGE.md` (sibling to PROFILE.md) plus a brief stdout summary. Flags: `--json` for machine output; generated-at timestamp combats staleness.
**Reasoning**: Workflow markers unify slash and NL triggering, especially in OpenCode where slash UX differs. Completed workflows measure follow-through, not just intent. Global XDG path matches PROFILE.md and fits cross-project scope naturally. A script avoids skill-lifecycle overhead while leveraging the existing corpus pipeline. Friction and failure analysis are deferred until an adoption baseline exists.
**Confidence**: provisional
**Feeds into**: TODO.md (implementation), standalone

## Decision 33 · 2026-04-28

**Question**: How should Agentera make multi-runtime setup feel simple while
keeping the 1.20 release stable?
**Context**: The 1.20 release supports Claude Code, OpenCode, Copilot CLI, and
Codex CLI, but setup still reads as four runtime stories plus helper scripts.
Marketplace users should not need a git clone to access shared tools. Skill
workflow scripts can live inside their owning skill, but doctor, installer,
hooks, validators, and compaction are suite infrastructure. No behavioral skill
should own them. Single-skill installs must still work for core behavior.
**Alternatives**:

- [Docs-only setup polish], rejected: leaves the real product gap unresolved.
- [Root scripts only], rejected: requires a clone and weakens marketplace installs.
- [One skill owns doctor/install], rejected: violates standalone-and-mesh ownership.
- [External CLI first], rejected: useful later, but adds another distribution surface.
- [Suite bundle first], chosen: aggregate installs carry shared infrastructure.
**Choice**: Make the installable Agentera suite bundle the primary home for
shared tools. Runtime marketplace installs should include skills, shared
scripts, hooks, manifests, and docs in one package root. `AGENTERA_HOME` points
to that installed root, not necessarily a clone. Doctor validates that bundle
without mutation; installer applies confirmed runtime-native fixes. External
CLI support is deferred.
**Reasoning**: Standalone skills mean core workflow independence, not that each
skill must carry every shared helper. Suite installs should provide suite
infrastructure. This keeps behavioral skill ownership clean while letting
co-installed skills mesh through one verified package root.
**Confidence**: firm
**Feeds into**: PLAN.md, README.md, scripts/

## Decision 34 · 2026-04-29

**Question**: How should agentera prevent artifact prose from snowballing toward verbosity and abstraction over long-running projects?
**Context**: The inspirera analysis of WRITING.md revealed a gap: existing compaction thresholds (§4) cap entry count but not entry quality. Over 300+ cycles, the 10 full-detail slots per artifact fill with increasingly verbose, abstract prose. This matches the profile entries "Be Direct And Concise" (88% effective) and "Reject Bloated Operational Artifacts" (77%). WRITING.md's self-audit workflow provides the operational pattern, but agentera needs its own check spec.
**Alternatives**:

- [New inspektera audit dimension], rejected: post-only; drift is already entrenched by the time it reaches periodic audit.
- [Section 24 extension with pre + post layers], chosen: pre-write gate catches at the source; post-layer catches what slips through.
- [PostToolUse validation hook], rejected: hooks validate artifact structure, not content quality; prose checks need semantic judgment.
**Choice**: Extend SPEC.md §24 with a "Self-Audit Protocol" defining 3 agentera-native checks. Each artifact-producing skill runs them as a mandatory pre-write gate. Post-layer: dokumentera enforces for docs, inspektera adds a "prose health" audit dimension for all artifacts. The 3 checks are: (1) verbosity drift — word count vs. §4 token budget, fail if over; (2) abstraction creep — entry must contain ≥1 concrete anchor (file path, line number, commit hash, metric value, identifier, or direct quote); (3) filler accumulation — scan for banned verbosity patterns (§24), fail if any found.
**Reasoning**: WRITING.md's regularity checks are the right philosophy but the wrong spec — agentera's structured, token-budgeted, multi-skill artifact format needs its own check design. A mandatory pre-write gate is the only way to prevent the snowball: advisory gates accumulate drift faster than post-audits can clean it up. This matches "Reject Quality Gate Bypasses" (86% effective). The post-layer exists because pre-write gates can't catch everything — some abstraction creep is only visible when comparing entries across time.
**Confidence**: firm
**Feeds into**: SPEC.md (§24 extension), skills/inspektera/SKILL.md (prose health dimension), skills/dokumentera/SKILL.md (doc prose enforcement), SKILL.md files of all producing skills (pre-write gate step)

## Decision 35 · 2026-04-29

**Question**: Should the three §24 self-audit checks be extracted from duplicated SKILL.md prose into a shared Python module?

**Context**: SPEC.md §24 defines three pre-write checks duplicated as identical 13-line blocks across 8 SKILL.md files, enforced only by Claude's behavioral compliance. Inspirera analysis of open-bias identified evaluation/enforcement separation as the highest-ROI transferable concept. Profile entries "Use Hooks As Enforcement" (conf:82) and "Reject Bloated Operational Artifacts" (conf:77) favor programmatic enforcement over prose-only instructions.

**Alternatives**:

- [Build shared self_audit.py module], chosen: one implementation consumed by PostToolUse hook (hard gate), all 8 producing skills (replacing prose), and inspektera prose health dimension.
- [Keep prose-only], rejected: duplicated logic, no programmatic enforcement, inspektera re-implements independently.
- [Hook-only], rejected: skills lose quality ownership; inspektera still needs separate implementation.

**Choice**: Build `scripts/self_audit.py` implementing the three §24 checks as importable functions. Wire into `validate_artifact.py` for automatic enforcement. Replace 8 duplicated prose blocks with module calls. Inspektera uses the same module.

**Reasoning**: Three consumers, one implementation — the code-level follow-through on Decision 34's self-audit protocol. Mirrors open-bias evaluation/enforcement separation: module evaluates, hook enforces, skills retain ownership.

**Confidence**: firm
**Feeds into**: TODO.md

## Decision 36 · 2026-04-29

**Question**: Should generate_contracts.py produce structured JSON validation schemas alongside prose contracts?

**Context**: SPEC.md §2, §4, and §5 define validation constants (required headings, token budgets, severity mappings, artifact paths) that validate_artifact.py duplicates as hardcoded Python dicts. SPEC.md changes require manual sync. The inspirera analysis identified the open-bias RULES.md → compiler → runtime-config pattern as transferable. Decision 35 covers §24 self-audit checks; this addresses the §2/§4/§5 structural contract surface.

**Alternatives**:

- [Parse SPEC.md tables into JSON, narrow v1 scope], chosen: targeted regex extraction from existing Markdown tables — no spec format changes. v1 covers artifact headings, token budgets, severity mappings, artifact paths. validate_artifact.py replaces hardcoded dicts with the generated JSON. Broader protocol surface (compaction, confidence, visual tokens) in follow-on.
- [Embedded metadata blocks in SPEC.md], rejected: dual-format maintenance without sufficient v1 benefit.
- [Defer], rejected: internal consumers have low pain today, but the spec-as-protocol north star requires machine-readable output before external consumers arrive.

**Choice**: Add a --schema flag to generate_contracts.py outputting structured JSON (default: scripts/schemas/contracts.json) by parsing SPEC.md tables. Ship v1 with the validate_artifact.py replacement. Extend to full protocol surface in follow-on cycles.

**Reasoning**: The compiler already walks SPEC.md sections — extending it to extract structured data from known tables is additive, not architectural. The hook replacement proves the schema works and eliminates the manual sync burden.

**Confidence**: firm
**Feeds into**: TODO.md

## Decision 37 · 2026-04-29

**Question**: Should hooks/validate_artifact.py add an explicit fail-open contract to prevent crashes from blocking agent writes?

**Context**: The hook currently exits 0 for Claude Code (advisory warnings) but uses deny/exit-2 for Copilot, OpenCode, and Codex pre-write paths. There is no top-level exception handler — an unhandled crash would propagate and could block all writes. The inspirera analysis identified open-bias's fail-open pattern (safe_hook catches all, logs, passes through) as a low-effort safety improvement.

**Alternatives**:

- [Top-level try/except only], chosen: wrap main() in try/except — catch all exceptions, log with traceback, exit 0. Existing blocking logic unchanged. No timeout. Minimal, immediately effective.
- [Full contract with timeout], rejected: adds platform-dependent complexity (signal handling) without proportional safety gain at v1.
- [Do nothing], rejected: implicit fail-open is not the same as explicit. The contract should be unambiguous.

**Choice**: Wrap main() in hooks/validate_artifact.py with a top-level try/except. On unhandled exception, log the error with traceback to stderr and exit 0 (allow through). Add a comment documenting the fail-open contract. No changes to existing blocking paths.

**Reasoning**: One try/except prevents crashes from blocking the agent. The existing blocking paths (structural violations on Copilot/OpenCode/Codex) are explicit and intentional — they don't need fail-open protection. This catches only the unexpected.

**Confidence**: firm
**Feeds into**: TODO.md

## Decision 38 · 2026-04-30

**Question**: How should Agentera implement SOB-inspired structured-output benchmark concepts?
**Context**: Inspirera analysis of Interfaze SOB showed that schema-valid output can still be value-wrong. Agentera has runtime smoke tests in `scripts/eval_skills.py`, artifact validators in `hooks/validate_artifact.py`, and Section 20 reality verification, but `eval_skills.py` explicitly does not evaluate output correctness.
**Alternatives**:

- [Anchor on value-level skill evals], chosen: tests visible skill output and artifact-derived meaning before broader scoring.
- [Anchor on artifact field recall], rejected: useful later, but risks repeating the schema-only trap.
- [Anchor on weighted summaries], rejected: premature until semantic correctness signals exist.
- [Extend eval_skills.py directly], rejected: smoke and semantic evals have different boundaries.
**Choice**: Add a separate stdlib semantic eval surface, starting with `hej` routing fixtures that assert both output facts and artifact-derived next-action correctness.
**Reasoning**: `hej` proves the core SOB lesson in Agentera terms: a clean response is not enough if it routes to the wrong concrete work. A separate script keeps runtime smoke checks simple while semantic fixtures grow.
**Confidence**: firm
**Feeds into**: TODO.md

## Archived Decisions

- Decision 1 (2026-03-29): **Question**: How should planera (a planning skill) be designed to fit the agent-skills suite?
- Decision 2 (2026-03-29): **Question**: Should the vision brainstorm be extracted from realisera into a dedicated skill?
- Decision 3 (2026-03-29): **Question**: How should dokumentera (a documentation skill) be designed for the suite?
- Decision 4 (2026-03-30): **Question**: how should skill-generated docs and artifacts integrate with existing project documentation conventions?
- Decision 5 (2026-03-30): **Question**: should visionera's VISION.md include a product identity layer (brand personality, voice, aesthetic, communication style)?
- Decision 6 (2026-03-30): **Question**: how should the DESIGN.md spec be absorbed into the skill suite, given skills must work standalone?
- Decision 7 (2026-03-30): **Question**: How should the skill ecosystem enforce cross-skill alignment and prevent shared primitives from diverging as skills are added?
- Decision 8 (2026-03-30): **Question**: Should the ecosystem unify its confidence model, and if so, on what scale?
- Decision 9 (2026-03-31): **Question**: What should this skill ecosystem be named? The current name "agent-skills" is generic and doesn't represent what it is...
- Decision 10 (2026-03-31): **Question**: Which patterns from gstack (garrytan/gstack) should agentera adopt, defer, or reject?
- Decision 11 (2026-03-31): **Question**: How should agentera express its identity visually across skills and artifacts?
- Decision 12 (2026-03-31): **Question**: How should version management work across the agentera ecosystem, both for agentera's own skill versions and for target projects...
- Decision 13 (2026-04-01): **Question**: Should agentera artifacts be consolidated out of the project root, and should their naming adopt common conventions?
- Decision 14 (2026-04-02): **Question**: How should the ecosystem's user-facing messages be formatted?
- Decision 15 (2026-04-02): **Question**: How should TODO.md categorize issues beyond bug-severity, and should issues carry type tags?
- Decision 16 (2026-04-02): **Question**: How should the ecosystem's voice and tone work across all 11 skills?
- Decision 17 (2026-04-02): **Question**: How should skills narrate their process between structural markers?
- Decision 18 (2026-04-02): **Question**: How should the ecosystem handle em-dashes and double dashes in all text?
- Decision 19 (2026-04-02): **Question**: How should the ecosystem handle line-breaks in prose text?
- Decision 20 (2026-04-02): **Question**: Should the agentera ecosystem add an orchestration skill, and what should it own?
- Decision 21 (2026-04-02): **Question**: How should autonomous plans constrain test generation to prevent unbounded output?
- Decision 22 (2026-04-03): **Question**: Should ISS-19 phase tracking be enforced across skills, and how should the ecosystem detect stale artifacts?
- Decision 23 (2026-04-03): **Question**: Where should session-to-session state live: new SESSION.md artifact, extend PROGRESS.md, or infrastructure dotfile?
- Decision 24 (2026-04-03): **Question**: Should the PostToolUse validation hook coexist with the git pre-commit hook, or replace it?
- Decision 25 (2026-04-03): **Question**: Should agentera's North Star evolve from "a solo founder installs an engineering team" to a spec-centric framing?
- Decision 26 (2026-04-10): **Question**: Should the terminology for the ecosystem spec and per-skill context files be renamed for clarity and cohesion?
- Decision 27 (2026-04-11): **Question**: How to implement Section 21's session corpus contract to close the gap between spec and extraction pipeline
- Decision 28 (2026-04-11): **Question**: Where should PROFILE.md and profilera's generated artifacts live by default, and how should runtime adapters provide path overrides?
