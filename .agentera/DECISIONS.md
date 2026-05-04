# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions are referenced by realisera, optimera, and profilera for context on why choices were made.

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

## Decision 39 · 2026-05-04

**Question**: What should Agentera 2.0 look like, and should it be a rewrite or an incremental refactor?
**Context**: After 254+ cycles, 38 decisions, 577 tests, and 4 runtime targets, three systemic pains dominate: token consumption per session is high (large SKILL.md payloads + artifact ceremony), maintenance surface is scattered (3-way artifact identity sync, 908-line validate_artifact.py monolith, ~180 lines duplicated install-root logic), and the 12-skill model fragments the feedback loop across many files. The system works but is costly to operate and heavy to evolve.
**Alternatives**:

- [Targeted refactors]: fix 3-way sync, decompose validate_artifact.py, extract shared scripts. ~70% of maintenance benefit at ~10% of cost. Rejected: doesn't address token consumption or artifact ceremony, which are structural problems.
- [12 autonomous skills with companion schemas]: keep the current distribution model but add per-skill schemas and selective reading. Rejected: cross-skill mesh complexity persists; the 12-file distribution model remains a token tax.
- [Single bundled skill with capability schemas]: one install, one entry point, 12 capabilities as sub-modules with lean prose + companion schemas. Chosen.
  **Choice**: Agentera 2.0 is a single bundled skill (`/agentera`) with 12 capabilities. Each capability has lean behavioral prose + companion schemas (artifact shapes, validation rules, triggers). A thin shared protocol schema covers confidence, severity, and visual tokens. SPEC.md dissolves into capability schemas. Artifacts split: 3 human-facing at root (TODO.md, CHANGELOG.md, DESIGN.md), rest as structured agent-facing data in `.agentera/`. A universal query CLI replaces direct artifact reads. Master SKILL.md starts full (hej-style orientation + routing), optimizes toward thin schema-driven dispatcher over time. Transition: big bang cutover from a feat/v2 branch/worktree.
  **Reasoning**: The feedback loop is the core product, and it's fragmented across 12 skill files and 12 artifact formats. Bundling with schema-driven dispatch and a query CLI concentrates the loop into one deep module. Structured artifacts + query CLI eliminates the read/write ceremony that burns tokens. The worktree strategy preserves the working system during development. The strongest blind spot (master SKILL.md becoming a God Object) is mitigated by schema-driven routing and a stated optimization trajectory from full to thin.
  **Confidence**: firm
  **Feeds into**: ROADMAP.md, VISION.md

## Decision 40 · 2026-05-04

**Question**: How should the four open questions from the ROADMAP be resolved: artifact format, master SKILL.md size, backward compatibility, and sub-module naming?
**Context**: Decision 39 committed to Agentera 2.0. ROADMAP.md listed four open questions blocking Phase 1. A token-profile experiment measured YAML vs JSON vs JSONL for representative PROGRESS entries.
**Alternatives**:

- [YAML]: human-glanceable, smallest bytes for single entries. Token experiment showed ~18% more tokens than JSONL for 10-entry files, but query CLI abstracts the format so raw tokens never enter agent context. Chosen for artifacts.
- [JSONL]: most compact for multi-entry files, append-friendly. Rejected: marginal token savings irrelevant when CLI is the interface.
- [JSON]: best schema validation tooling (JSON Schema universal). Rejected: larger than YAML for single entries, no meaningful advantage when CLI abstracts access.
  **Choice**: YAML for all agent-facing artifacts. No backward compatibility with v1 (migration tool handles conversion). Sub-modules called "capabilities." Master SKILL.md size deferred to Phase 1 (measure after hej port).
  **Reasoning**: The token experiment proved format choice doesn't affect agent-visible token consumption because the query CLI is the seam. YAML wins on human-glanceability and smallest bytes for typical single-entry reads. No backward compat is consistent with D39's big bang. "Capabilities" aligns with SKILL.md vocabulary and distinguishes from the v1 "skills" concept.
  **Confidence**: firm
  **Feeds into**: ROADMAP.md

## Decision 41 · 2026-05-04 · completed

**Title**: Agentera 2.0 Token Benchmark

**v1 baseline** (all 12 `skills/*/SKILL.md` + `SPEC.md`):

| Component                         | Bytes       |
| --------------------------------- | ----------- |
| 12 SKILL.md files                 | 256,314     |
| SPEC.md                           | 95,899      |
| **Total**                         | **352,213** |
| Estimated tokens (~4 chars/token) | ~88,053     |

**v2 measurement** (`SKILL.md` + `protocol.yaml` + 12 `prose.md` + 48 schema files):

| Component                         | Bytes       |
| --------------------------------- | ----------- |
| SKILL.md                          | 5,381       |
| protocol.yaml                     | 13,704      |
| 12 prose.md files                 | 210,827     |
| 48 schema YAML files              | 83,444      |
| **Total**                         | **313,356** |
| Estimated tokens (~4 chars/token) | ~78,339     |

**Delta**: -38,857 bytes (**-11.0%**), estimated -9,714 tokens.

**Methodology**: `wc -c` on all measured files. Token estimate uses 4 chars/token for English text (conservative; real tokenizer ratios vary). v1 measured from main worktree, v2 from feat/v2 worktree. Both include all content a runtime must read to dispatch a skill/capability.

**Note**: The ROADMAP.md aspirational target of 40% reduction assumed that schema extraction would offload more structural prose. The actual -11.0% reflects that capability prose.md files retain substantial behavioral instructions while schema files add ~83 KB of machine-readable structure. The token win is modest, but the structural payoff (machine-readable schemas, query CLI potential, single dispatch point) was the primary motivation per D39.

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
- Decision 29 (2026-04-11): **Question**: How should optimera handle measurement archetypes that go beyond thin command-wrapper harnesses, and what should the first such reference...
- Decision 30 (2026-04-12): **Question**: How should the realisera-token harness be redesigned after three consecutive discarded experiments where run-to-run variance (13-20%) drowned the optimization...
