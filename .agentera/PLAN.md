# Plan: Platform Portability

<!-- Level: full | Created: 2026-04-10 | Status: active -->

## What

Make agentera's ecosystem spec and skill structure honestly platform-agnostic by abstracting Claude Code-specific conventions behind a host adapter contract, explicitly scoping what is portable today, and separating host-specific extensions from the portable core. Define what a host runtime must provide to run core agentera skills, add a session-corpus contract for profilera's future portability, audit and annotate platform-specific references, and produce a proof-of-concept adapter design for OpenCode that validates both contracts are sufficient.

## Why

The updated VISION.md Direction says "any agent CLI that speaks the protocol can run agentera skills." Right now that overstates reality: many skills are close, but profilera still depends on Claude-specific session data, and orchestration skills depend on runtime primitives that are not universally available. The spec is the product but it's a Markdown document, not a protocol. Until we define what portability actually means, scope the claim to the portable core, standardize the missing session corpus that profilera depends on, and prove it with at least one alternative runtime, the Direction claim is unearned. This plan earns it honestly.

## Constraints

- No changes to the current Claude Code experience: skills must continue working exactly as they do now
- the spec.md remains the single source of truth; new sections extend, don't replace
- SKILL.md files get annotations where a lexical marker is sufficient; sections that encode Claude-shaped control flow may need small rewrites, not just comments
- The adapter contract is defined in the spec, not implemented as code
- The session-corpus contract is defined in the spec as a normalized data model, not as Claude-shaped filesystem paths
- All existing linter checks must continue passing
- Decision 4 (DOCS.md artifact mapping) and Decision 13 (three conventional root files) remain authoritative
- The plan must not claim full portability for skills whose host-data dependencies are not yet standardized

## Scope

**In**: Ecosystem spec Section 20 (Host Adapter Contract), new Session Corpus Contract section for profilera portability, platform audit of all Claude Code-specific references, SKILL.md annotation convention for platform-specific content, OpenCode proof-of-concept adapter design document, em-dash fix, ISS-31 CI gating
**Out**: Building actual adapter implementations for other platforms, changing the current Claude Code plugin experience, refactoring the entire skill structure
**Deferred**: Adapter implementations (OpenCode, Gemini CLI, Codex CLI), multi-platform CI, per-platform documentation sites

## Design

The architecture adds one new concept to the ecosystem: the **host adapter**, a thin interface layer that each runtime implements. The spec defines the contract; the runtime provides the implementation. It also adds an explicit distinction between the **portable core** and **host-specific extensions** so the portability claim matches reality.

**Host Adapter Contract**: A runtime that wants to run agentera's portable core must provide:

1. **Skill discovery**: a mechanism to find and load SKILL.md files (Claude Code uses `.claude-plugin/` manifests + `settings.json` skillPaths; OpenCode would use its own config)
2. **Artifact resolution**: ability to read/write files at paths specified by DOCS.md or default layout (every runtime has filesystem access)
3. **Profile path**: a global configuration directory where PROFILE.md lives (Claude Code: `~/.claude/profile/`; OpenCode: `~/.config/opencode/` or XDG equivalent)
4. **Sub-agent dispatch**: ability to spawn subordinate agents with isolation (Claude Code: worktrees; other runtimes: containers, sandboxes, or sequential execution)
5. **Eval mechanism**: ability to invoke a skill against a prompt and capture output (Claude Code: `claude -p`; other runtimes: their own pipe mode or eval command)
6. **Hook lifecycle**: pre/post tool use, session start/stop callbacks (Claude Code: hooks.json; other runtimes: their own event system or a no-op shim)

The contract also needs **requirement levels**:

- **Required**: skill discovery, artifact resolution, profile path
- **Capability-gated**: sub-agent dispatch, eval mechanism
- **Optional but recommended**: hook lifecycle

And it needs a **portability status matrix**:

- **Portable core**: skills that depend only on shared artifacts plus required host capabilities
- **Capability-gated**: skills that are portable only when the adapter implements the extra runtime primitives they need
- **Host-specific extension**: skills that depend on a host data source not yet standardized by the spec, with profilera as the current example

The key insight: **capabilities, not implementations**. The spec doesn't say how to dispatch a sub-agent; it says what the skill expects from one. Each runtime implements those capabilities in its own way. But the spec must also say where the claim stops today: the six capabilities are sufficient for the portable core, not yet for host-specific extensions like profilera.

**Session Corpus Contract**: To make profilera portable, the spec needs one more layer above host capabilities: a normalized corpus of decision-relevant session signals. The contract should define canonical record types rather than Claude-specific file paths:

1. **memory_entry**: durable user/project memory captured by the host
2. **instruction_document**: global or project-scoped instruction files the host exposes
3. **history_prompt**: decision-rich prompts with timestamp, project, and session metadata
4. **conversation_turn**: normalized user or assistant turns with actor, content, timestamp, session_id, and project_id
5. **project_config_signal**: recurring config or toolchain patterns associated with a project

Each record type needs a minimum schema: stable source_id, timestamp, project_id, optional project_path, session_id where applicable, actor where applicable, content payload, source_kind, runtime, and adapter_version. The contract must also define degradation rules: what profilera can do with a partial corpus, what is required for full mode, and how missing source families are surfaced to the user.

The key design choice is **data model, not path model**. The contract standardizes the observable decision corpus, not where a host stores it. Claude Code can continue to derive this corpus from `.claude/`; OpenCode becomes the non-Claude proof that the same normalized schema can be produced from a different runtime.

**Annotation convention**: In SKILL.md files, platform-specific references get a comment that marks them as such. The linter validates that annotated references have a corresponding abstract description in the spec. This helps other runtimes identify lexical coupling points, but it does not replace small structural rewrites where a skill currently encodes Claude-specific control flow.

**Section 20 structure**: mirrors the existing spec pattern (rules, table, linter check). Defines the six host capabilities, the annotation convention, and validates that annotated SKILL.md references map to spec-defined capability names.

## Tasks

### Task 1: Ecosystem spec Section 20 - Host Adapter Contract
**Depends on**: none
**Status**: ■ complete
▸ GIVEN the spec.md Section 20 WHEN a host runtime implements the required capabilities and any needed capability-gated ones THEN it can run the portable core skills without modification to their behavioral intent
▸ GIVEN the spec.md Section 20 WHEN the annotation convention is read THEN it specifies the `<!-- platform: capability-name -->` comment format and lists all recognized capability names
▸ GIVEN the spec.md Section 20 WHEN the portability status table is read THEN profilera is explicitly scoped as a host-specific extension rather than implicitly claimed portable
▸ GIVEN the linter WHEN validate_spec.py is run THEN it passes with 0 new errors or warnings

### Task 2: Ecosystem spec Section 21 - Session Corpus Contract
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN a new the spec.md section for the session corpus contract WHEN read THEN it defines canonical record types for memory entries, instruction documents, history prompts, conversation turns, and project config signals
▸ GIVEN the contract section WHEN read THEN each record type has a minimum normalized schema including provenance metadata (runtime, adapter_version, source_kind) rather than Claude-specific file paths
▸ GIVEN the contract section WHEN read THEN it distinguishes required vs optional source families for profilera and specifies degradation behavior for partial corpus availability
▸ GIVEN profilera's current status in Section 20 WHEN Section 21 lands THEN profilera is no longer blocked on an unspecified future abstraction; the missing contract is concretely defined

### Task 3: Audit and annotate platform-specific references
**Depends on**: Task 1, Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN all 12 SKILL.md files WHEN platform-specific references are searched THEN every reference to ~/.claude/, .claude-plugin/, worktree isolation, claude -p, or hooks is either annotated, abstracted, or explicitly documented as host-specific
▸ GIVEN profilera-related references WHEN searched THEN Claude-specific corpus sources are called out as Claude adapter details, not presented as the portable contract
▸ GIVEN the spec.md WHEN platform-specific sections are checked THEN Section 4 (PROFILE.md path), Section 19 (skill repo archetype eval line), and the profile consumption convention reference the host adapter capability rather than hardcoding ~/.claude/
▸ GIVEN README.md WHEN installation instructions are read THEN they describe agentera's portable core as platform-agnostic with Claude Code as the current reference implementation, not as Claude-Code-only
▸ GIVEN the spec.md Section 1 (Confidence Scale) through Section 19 WHEN searched for "Claude Code" or hardcoded platform paths THEN all such references are either annotated or abstracted behind the host adapter contract

### Task 4: OpenCode proof-of-concept adapter design
**Depends on**: Task 1, Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN a new document references/adapters/opencode.md WHEN read THEN it maps each of the six host capabilities to OpenCode's specific mechanisms (skill discovery: opencode skill discovery convention, artifact resolution: filesystem, profile path: ~/.config/opencode/ or XDG, sub-agent dispatch: opencode's agent primitives, eval mechanism: opencode pipe mode or equivalent, hook lifecycle: opencode event hooks or no-op shim)
▸ GIVEN the same adapter document WHEN read THEN it also maps the Session Corpus Contract to OpenCode-specific sources or export mechanisms for each normalized record family
▸ GIVEN the adapter design document WHEN a developer reads it THEN they can implement OpenCode support for the portable core and a profilera-compatible session corpus without reading any SKILL.md source code; any remaining host-specific gaps are called out separately
▸ GIVEN the adapter design document WHEN compared to Section 20 and the session corpus contract THEN every required host capability and every normalized corpus source family is addressed explicitly

### Task 5: Linter update for annotation validation
**Depends on**: Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN validate_spec.py WHEN a SKILL.md contains a `<!-- platform: -->` annotation THEN the referenced capability name exists in Section 20's capability list
▸ GIVEN validate_spec.py WHEN a SKILL.md references ~/.claude/, .claude-plugin/, or claude -p THEN the linter does not error (these are legitimate Claude Code references, now annotated)
▸ GIVEN validate_spec.py WHEN run against all 12 SKILL.md files THEN 0 errors, 0 new warnings beyond the existing em-dash baseline
▸ GIVEN 4 new tests covering annotation validation WHEN run THEN all pass

### Task 6: Housekeeping - em-dash fix and ISS-31 CI gating
**Depends on**: none
**Status**: □ pending
**Acceptance**:
▸ GIVEN planera/SKILL.md line 130 WHEN the em-dash is replaced THEN validate_spec.py reports 0 errors (the last remaining em-dash error is resolved)
▸ GIVEN a CI configuration file (GitHub Actions or equivalent) WHEN pushed THEN the test suite runs automatically on push and PR
▸ GIVEN ISS-31 in TODO.md WHEN CI is configured THEN the issue is marked resolved with a commit reference

### Task 7: Version bump per DOCS.md convention
**Depends on**: Task 5, Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all version_files listed in DOCS.md WHEN checked THEN every file is bumped from 1.7.0 to 1.8.0 (feat = minor), profilera from 2.6.0 to 2.7.0
▸ GIVEN registry.json and marketplace.json WHEN parsed THEN all version references are consistent
▸ GIVEN CHANGELOG.md WHEN read THEN an [Unreleased] section exists with Added entries for Section 20, the Session Corpus Contract, platform annotations, OpenCode adapter design, and CI configuration

### Task 8: Plan-level freshness checkpoint
**Depends on**: Task 7
**Status**: □ pending
**Acceptance**:
▸ GIVEN CHANGELOG.md WHEN read THEN it has a version entry with all substantive changes from this plan
▸ GIVEN PROGRESS.md WHEN the latest cycle entry is read THEN it summarizes the plan's work at the plan level
▸ GIVEN TODO.md WHEN read THEN ISS-31 is resolved and any new issues from this plan are filed

## Overall Acceptance
▸ GIVEN the ecosystem spec WHEN Sections 20 and 21 are read THEN a runtime that implements the required capabilities, any needed capability-gated ones, and the normalized session corpus can run the portable core plus profilera's corpus-dependent flow without relying on Claude-specific paths
▸ GIVEN all SKILL.md files WHEN searched for bare platform-specific references (without annotation) THEN zero results in portable-core claims; remaining host-specific dependencies are called out explicitly
▸ GIVEN the OpenCode adapter design document WHEN a developer follows it THEN they have enough information to implement portable-core agentera support and a profilera-compatible session corpus in OpenCode without reading SKILL.md source
▸ GIVEN the linter and test suite WHEN run THEN 0 errors and all tests pass
▸ GIVEN all filenames and prose WHEN searched for "the spec" or "ecosystem-context" or "contract" THEN zero results; all references use "SPEC.md", "contract.md", "the spec", or "contract" appropriately

### Task 9: Terminology cleanup: the spec and ecosystem-context rename
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN references/the spec.md WHEN renamed THEN it becomes SPEC.md at the repo root (uppercase per artifact convention)
▸ GIVEN skills/*/references/contract.md WHEN renamed THEN each becomes skills/*/references/contract.md (lowercase per reference file convention)
▸ GIVEN the HTML comment `<!-- ecosystem-context: <skill> -->` WHEN updated THEN it becomes `<!-- contract: <skill> -->`
▸ GIVEN the source hash comment `<!-- source: references/the spec.md ... -->` WHEN updated THEN it becomes `<!-- source: SPEC.md ... -->`
▸ GIVEN the section header in SKILL.md files that reads "Ecosystem context" or "contract" WHEN updated THEN it reads "Contract" or "contract" appropriately
▸ GIVEN scripts/validate_spec.py WHEN renamed THEN it becomes scripts/validate_spec.py and all internal references (path strings, error messages, variable names referencing "ecosystem") are updated
▸ GIVEN scripts/generate_contracts.py WHEN renamed THEN it becomes scripts/generate_contracts.py and all internal references are updated (filename references, output paths, variable names, help text)
▸ GIVEN the spec in prose references throughout (SKILL.md files, spec itself, DECISIONS.md, PROGRESS.md, CLAUDE.md) WHEN searched for "the spec" or "contract" THEN all are replaced with "the spec" or "contract" appropriately
▸ GIVEN the linter WHEN validate_spec.py runs (after rename) THEN all check functions still work, referencing SPEC.md and contract.md paths
▸ GIVEN tests/ WHEN run THEN all tests pass with new filenames and script names
▸ GIVEN CHANGELOG.md WHEN read THEN an [Unreleased] entry exists for this terminology change

## Surprises
▸ ISS-31 (CI gating) has been previously deferred three times. Task 5 includes it but the scope (choosing a CI service, configuring runners, setting up merge gates) may exceed a single realisera cycle. If so, split CI into a separate follow-up plan and only ship the em-dash fix in this cycle.
