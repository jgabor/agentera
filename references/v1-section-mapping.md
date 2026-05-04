# v1-to-v2 Section Mapping

Maps every behavioral section in the 12 v1 SKILL.md files to the v2 capability schema groups.
No unmappable content.

## Mapping Table

| v1 Section | v2 Target | Rationale |
|---|---|---|
| Frontmatter: `name`, `description` | `prose.md` (header) + `TRIGGERS` group | Name is prose identity. Description is prose metadata. Trigger patterns extracted to TRIGGERS entries. |
| Frontmatter: `spec_sections` | Dropped | SPEC.md dissolves into per-capability schemas (ROADMAP: "Spec dissolves into schemas"). No central spec to reference. |
| `## State artifacts` (artifact list) | `ARTIFACTS` group | Each consumed/produced artifact becomes an ARTIFACTS entry with stable ID. |
| `### Artifact path resolution` | `ARTIFACTS` group (path metadata) | Path resolution rules become path field metadata on artifact entries. |
| `### Contract` (inlined values) | `VALIDATION` group + `protocol.yaml` | Inlined contract values (severity arrows, trend arrows, glyphs, token budgets) become shared protocol primitives referenced by VALIDATION entries. |
| `references/contract.md` | `protocol.yaml` | Centralized contract reference replaced by shared protocol schema. |
| `## Step N: ...` (workflow steps) | `prose.md` | Behavioral instructions the agent reads. Steps remain prose. |
| `## Brainstorm: ...` (sub-workflows) | `prose.md` | Interactive sub-workflows are behavioral instructions. |
| `## Personality` / `## Interaction rules` | `prose.md` | Personality and interaction rules are agent-facing behavioral guidance. |
| `## Safety rails` | `VALIDATION` group | Each safety rail becomes a VALIDATION entry with rule, severity, and checks. |
| `## Exit signals` | `EXIT_CONDITIONS` group | Each exit signal becomes an EXIT_CONDITIONS entry with condition, description, and exit_code. |
| `## Cross-skill integration` | `ARTIFACTS` group (cross-capability refs) + `prose.md` | Cross-skill dependencies become ARTIFACTS entries with cross-capability ID references. Integration guidance stays in prose. |
| `## Getting started` | `prose.md` | First-run guidance is behavioral instruction. |
| `references/templates/` | `prose.md` (embedded or referenced) | Templates are part of the capability's behavioral instructions. |
| `scripts/` (Python helpers) | Kept at repo level or capability-local | Scripts are tooling, not behavioral. Location unchanged for v2. |

## Per-Skill Coverage

Every section found in each v1 SKILL.md is covered by the mapping above. Verification:

| Skill | Sections | All Mapped? |
|---|---|---|
| dokumentera | State artifacts, Contract, Conventions, Artifact Mapping, Index, Steps 0, First-run, Intent-first, Explore-and-generate, Update-and-verify, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| hej | State artifacts, Contract, Steps 0-2 (Detect, Welcome, Briefing, Route), Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| inspektera | State artifacts, Contract, Audit template, Steps 1-7, Dimensions, Evidence, Confidence, Findings, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| inspirera | Steps 1-5, Source overview, Concepts, Applicability, Next steps, Exit signals, State artifacts, Cross-skill, Safety rails, Getting started, Notes on depth | Yes |
| optimera | State artifacts, Objective template, Experiment template, Closure template, Brainstorm, Cycle, Hypothesis, Constraints, Safety rails, Blocked handling, Exit signals, Cross-skill, Getting started | Yes |
| orkestrera | State artifacts, Personality, Conductor protocol, Task template, Acceptance template, Context, Verification, Output format, Lean conductor, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| planera | State artifacts, Contract, Steps 0-6, Plan template (quick + full), Acceptance criteria, Handoff, How realisera reads PLAN, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| profilera | State artifacts, Steps 0, Full mode, Profile template, Validate mode, Safety rails, Exit signals, Cross-skill, Getting started, Notes on depth | Yes |
| realisera | State artifacts, Contract, VISION template, PROGRESS template, TODO template, CHANGELOG template, Brainstorm, Cycle, Task, Constraints, Safety rails, Blocked handling, Exit signals, Cross-skill | Yes |
| resonera | State artifacts, Decision template, Personality, Interaction rules, Starting a session, Running state, Good questions, Done handling, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| visionera | State artifacts, Contract, VISION template, Steps 0, Create mode, Refine mode, Safety rails, Exit signals, Cross-skill, Getting started | Yes |
| visualisera | State artifacts, Contract, Design template, Steps 0, Create, Refine, Audit modes, Safety rails, Exit signals, Cross-skill, Getting started | Yes |

## Unmappable Content

None. Every section in every v1 SKILL.md maps to one of: `prose.md`, `TRIGGERS`, `ARTIFACTS`, `VALIDATION`, `EXIT_CONDITIONS`, or `protocol.yaml` (shared primitives extracted from Contract sections).
