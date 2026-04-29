# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions are referenced by realisera, optimera, and profilera for context on why choices were made.

## Decision 25 · 2026-04-03

**Question**: Should agentera's North Star evolve from "a solo founder installs an engineering team" to a spec-centric framing?
**Context**: 80 cycles have proven the compounding model works. The current vision is user-centric (one person, one problem, one transformation). But the domain has moved: Agent Skills is an open standard adopted by multiple platforms, 150+ skills exist in the ecosystem, multi-agent orchestration is mainstream. The Direction section already says "the spec becomes the gravity well," suggesting the North Star was lagging behind the project's actual ambition.
**Alternatives**:

- [Keep user-centric North Star, update supporting paragraphs], rejected: the frame has been outgrown; both audience ("solo founder") and transformation ("installs a team") feel past tense
- [Compounding intelligence as North Star ("the system that gets smarter")], rejected: describes a property of the system, not the ambition
- [Spec as North Star with adoption arc in Direction], chosen
**Choice**: North Star becomes "The open standard for turning AI agents into engineering teams." Cool, declarative one-liner. Supporting paragraphs carry the emotional weight: two-layer problem (individual amnesia + ecosystem fragmentation), the insight (artifact contracts = memory, shared primitives = common language), the ambition (the spec as industry gravity well). Solo founder persona stays as the human grounding (the why behind the spec). Direction becomes the adoption arc: reference implementation, third-party skills, platform adoption, industry standard.
**Reasoning**: The key insight is that the spec is the product, not the twelve skills. The skills are the reference implementation that proves the spec works. This reframes agentera from a tool (install skills, get a team) to a protocol (agents that speak this language become teams). The solo founder persona stays because the spec exists to solve her problem, not as abstract standards work. The problem statement gains a second layer: amnesia is the individual problem, fragmentation is the ecosystem problem. The spec solves both.
**Confidence**: firm
**Feeds into**: VISION.md (North Star, Direction, supporting paragraphs)

## Decision 26 · 2026-04-10

**Question**: Should the terminology for the ecosystem spec and per-skill context files be renamed for clarity and cohesion?
**Context**: Two filenames (`SPEC.md` and `contract.md`) use a double-word "ecosystem-" prefix that is redundant (agentera IS the ecosystem), mechanically named (the context file is spec excerpts, not "context" in the operational sense), and inconsistent (prose uses "the spec" while filenames use "the spec"). The external AI community (Google Workspace CLI, Justin Poehnelt's agent DX article) uses CONTEXT.md for runtime agent instructions, creating collision risk. The rename cascades into 12 SKILL.md files, 2 Python scripts, the linter, tests, HTML comment conventions, and prose throughout.
**Alternatives**:

- [Keep current names], rejected: "ecosystem-context" is opaque, two-word, and collides with emerging CONTEXT.md convention for runtime agent instructions. The file contains binding spec excerpts, not operational context.
- [Rename to context.md only], rejected: collision with the emerging agent community's CONTEXT.md convention (Google Workspace CLI, Justin Poehnelt). CONTEXT.md means "runtime instructions for agents" externally.
- [Rename spec-only], rejected: renaming the spec without renaming the per-skill excerpts misses the relationship clarity opportunity
**Choice**: `SPEC.md` (root, uppercase per artifact convention) and `contract.md` (per skill in references/, lowercase per reference file convention). Drop the "ecosystem-" prefix from all filenames, headers, script names, and prose.
**Reasoning**: The contract is a binding excerpt: the skill MUST follow these rules. "Contract" carries the obligation that "context" lacks. The pair is clean: the spec defines the rules, your contract is your binding slice. Dropping "ecosystem-" from everywhere eliminates redundancy (agentera IS the ecosystem). Upper/lower case split follows the existing convention: root artifacts are UPPERCASE (VISION.md, TODO.md), skill reference files are lowercase (harness-guide.md, audit-commands.md). The rename makes the spec a first-class root artifact rather than hiding it in references/.
**Confidence**: firm
**Feeds into**: PLAN.md (Platform Portability plan)

## Decision 27 · 2026-04-11

**Question**: How to implement Section 21's session corpus contract to close the gap between spec and extraction pipeline
**Context**: Section 21 defines four normalized record types (instruction_document, history_prompt, conversation_turn, project_config_signal) with provenance metadata, but extract_all.py bypasses the contract entirely, going from Claude Code JSONL internals to four ad-hoc intermediate JSON files. The spec exists; the implementation does not. Users may also switch between runtimes (Claude Code, OpenCode) between sessions, so the corpus must be runtime-agnostic.
**Alternatives**:

- [Separate adapter layer] new script translates extract_all.py output into Section 21 format, rejected: unnecessary indirection, two scripts maintaining the same knowledge
- [Runtime-specific adapters] each runtime ships its own adapter, profilera just expects corpus.json, rejected: user may switch runtimes between sessions, corpus must aggregate across all available runtimes
- [Current runtime only] detect and extract from whichever runtime is active, rejected: decision patterns are runtime-agnostic, older data from a different runtime is still valid signal
- [Four files, normalized schemas] keep the four-file split but apply Section 21 schemas, rejected: unnecessary complexity when a single file with source_kind filtering is cleaner
**Choice**: Refactor extract_all.py into a multi-runtime corpus builder that probes for available runtime data, extracts from all detected runtimes, and produces a single self-describing corpus.json with a metadata envelope and normalized Section 21 records. Adapter self-validates. Section 21 updated to specify the envelope format.
**Reasoning**: Runtime is provenance metadata, not a freshness signal. A user's decision patterns are the same regardless of which tool produced the record. Staleness is time-based, not runtime-based. The 1M context window is sufficient for multi-runtime data, and profilera runs rarely enough that the marginal token cost is justified by a more complete picture. Compression of extracted data before LLM consumption is a future optimization. Self-validation at the adapter catches malformed output at the source rather than letting it propagate to profilera.
**Confidence**: firm
**Feeds into**: TODO.md (ISS-37)

## Decision 28 · 2026-04-11

**Question**: Where should PROFILE.md and profilera's generated artifacts live by default, and how should runtime adapters provide path overrides?
**Context**: PROFILE.md was stored at `~/.claude/profile/PROFILE.md`, coupling it to Claude Code's config directory. This triggers permission prompts when skills read it, doesn't work on Windows, and treats the profile as Claude Code's data rather than agentera's. The `PROFILERA_PROFILE_DIR` env var was added (Decision 27 implementation) but nothing sets it automatically.
**Alternatives**:

- [Keep ~/.claude/profile/ default] other runtimes override via env var, rejected: profile belongs to agentera not Claude Code, triggers permission prompts, not cross-platform
- [Skill derives path from runtime detection] skill detects runtime and maps to path internally, rejected: breaks separation of concerns; the adapter should own path knowledge
- [Shared config file mapping] a .agentera/runtime.json maps runtime to paths, rejected: unnecessary indirection for a single path
- [General pattern for all Section 20 capabilities] every capability gets a PROFILERA_* env var, rejected: profile-path is the only capability that maps to a filesystem directory
**Choice**: Default to XDG-standard data directory: `$XDG_DATA_HOME/agentera/` on Linux (default: `~/.local/share/agentera/`), `~/Library/Application Support/agentera/` on macOS, `%APPDATA%/agentera/` on Windows. Adapter plugins set `PROFILERA_PROFILE_DIR` at init to override. Auto-migrate existing profiles from `~/.claude/profile/` on first run. stdlib-only platform detection.
**Reasoning**: The profile is agentera's data, not a runtime's. XDG is the standard for user application data on Linux; macOS and Windows have their own equivalents. Moving to an agentera-owned directory eliminates permission friction, enables cross-platform support, and removes the implicit Claude Code coupling. Auto-migration ensures existing users don't lose their profile. The env var remains the adapter injection point (set at plugin init), keeping the skill-adapter separation clean. Only profile-path needs this treatment; other Section 20 capabilities are about runtime mechanisms, not filesystem paths.
**Confidence**: firm
**Feeds into**: TODO.md

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
