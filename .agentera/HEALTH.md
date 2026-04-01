# Health

## Audit 4 — 2026-04-01

**Dimensions assessed**: architecture alignment, pattern consistency, coupling health, test health, version health, dependency health
**Findings**: 3 critical, 14 warnings, 6 info (0 filtered by confidence)
**Overall trajectory**: first full audit (6 dimensions vs prior 2); architecture ⮋ B→C, patterns stable B→B
**Grades**: Architecture [C] | Patterns [B] | Coupling [B] | Tests [D] | Version [B] | Deps [B]

### Architecture alignment: C

#### ⇉ No LICENSE file — warning (confidence: 100)
- **Location**: repo root
- **Evidence**: No LICENSE/LICENSE.md exists. VISION.md states "openness over lock-in" and "open standard."
- **Impact**: All rights reserved by default; external use legally blocked
- **Suggested action**: Add LICENSE (MIT or Apache 2.0)

#### ⇉ Installation path double-nesting — warning (confidence: 95)
- **Location**: `README.md:85-106`
- **Evidence**: Clone to `~/.claude/skills` produces `~/.claude/skills/skills/inspirera`
- **Impact**: Confusing path; will generate user questions
- **Suggested action**: Clone to `~/.claude/agentera` instead

#### ⇉ Stale ISSUES-template.md — warning (confidence: 95)
- **Location**: `skills/realisera/references/templates/ISSUES-template.md`
- **Evidence**: D13 renamed ISSUES.md→TODO.md; template still says "# Issues"
- **Impact**: Contributors find deprecated template
- **Suggested action**: Rename to TODO-template.md, update content

#### ⇉ README intro omits two skills — warning (confidence: 95)
- **Location**: `README.md:3`
- **Evidence**: Lists 8 workflows, claims 10; missing research (inspirera) and design (visualisera)
- **Impact**: Two skills invisible in opening pitch
- **Suggested action**: Add "researching, designing"

#### ⇉ README diagram incomplete for inspirera — warning (confidence: 90)
- **Location**: `README.md:27-48`
- **Evidence**: Diagram shows inspirera→planera only; text says realisera+optimera; SKILL.md shows 5 connections
- **Impact**: Ecosystem diagram understates inspirera
- **Suggested action**: Add edges or note as simplified

#### ⇢ CLAUDE.md layout omits plugin.json — info (confidence: 90)
- **Location**: `CLAUDE.md:10-21`
- **Evidence**: Layout shows SKILL.md, references/, scripts/ but not .claude-plugin/plugin.json
- **Impact**: Contributors miss plugin structure
- **Suggested action**: Add to layout block

### Pattern consistency: B

#### ⇉ inspirera section ordering anomaly — warning (confidence: 95)
- **Location**: `skills/inspirera/SKILL.md`
- **Evidence**: State artifacts after exit signals; safety rails after cross-skill. All 10 others follow canonical order.
- **Impact**: Inconsistent structure hinders navigation
- **Suggested action**: Reorder to canonical pattern

#### ⇉ inspirera missing ALWAYS/REQUIRED phrasing — warning (confidence: 95)
- **Location**: `skills/inspirera/SKILL.md:4-14`
- **Evidence**: Uses "Use this skill whenever" instead of "ALWAYS use"/"This skill is REQUIRED"
- **Impact**: Claude may skip skill for link analysis
- **Suggested action**: Add ALWAYS/REQUIRED/DO NOT trinity

#### ⇉ Output opening line placement inconsistency — warning (confidence: 95)
- **Location**: realisera, optimera define in cycle section; others in intro
- **Evidence**: 7 skills define in intro, 2 in cycle section, 1 (hej) uses dashboard
- **Impact**: Agents may miss opening line definition
- **Suggested action**: Standardize to intro paragraph

#### ⇉ inspirera lacks Step 0 — warning (confidence: 85)
- **Location**: `skills/inspirera/SKILL.md`
- **Evidence**: 8 of 10 other skills with detection start at Step 0; inspirera starts at Step 1
- **Impact**: Minor numbering inconsistency
- **Suggested action**: Renumber or accept variance

#### ⇢ Trailing "Notes" section in 2 skills — info (confidence: 90)
- **Location**: inspirera, profilera
- **Evidence**: "Notes on depth vs. speed" after Getting started; 9 others lack this
- **Impact**: Minor structural outlier
- **Suggested action**: Consider folding into workflow steps

### Coupling health: B

#### ⇉ README consumer tables stale vs ecosystem spec — warning (confidence: 88)
- **Location**: `README.md:58-75` vs `references/ecosystem-spec.md`
- **Evidence**: VISION.md missing dokumentera, visualisera as consumers; PROGRESS.md missing dokumentera, visionera
- **Impact**: README understates artifact mesh
- **Suggested action**: Sync with ecosystem spec

#### ⇉ .optimera/harness outside standard layout — warning (confidence: 78)
- **Location**: `skills/optimera/SKILL.md:39`
- **Evidence**: Only artifact outside .agentera/; undocumented in spec format contracts
- **Impact**: Not caught by .agentera/ tooling
- **Suggested action**: Document in spec or relocate

#### ⇉ Hardcoded profilera skill directory — warning (confidence: 78)
- **Location**: `skills/realisera/SKILL.md:185`, `skills/inspektera/SKILL.md:92`
- **Evidence**: Hardcodes `~/.claude/plugins/marketplaces/agentera/skills/profilera`; README suggests different path
- **Impact**: Profile script may fail if installed differently
- **Suggested action**: Remove hardcoded path

#### ⇢ Interface width clean — info (confidence: 92)
- **Location**: all cross-skill sections
- **Evidence**: Skills communicate only through published artifacts and script output
- **Impact**: None — healthy coupling

### Test health: D

#### ⇶ Zero unit tests for Python scripts — critical (confidence: 98)
- **Location**: 12 Python files across skills/*/scripts/ and scripts/
- **Evidence**: No test_*.py or *_test.py files anywhere. Scripts include regex parsing, exponential decay math, custom YAML parsing.
- **Impact**: Parsing changes break silently
- **Suggested action**: Add tests for parse functions in all 5 script modules

#### ⇶ No artifact format contract tests — critical (confidence: 88)
- **Location**: ecosystem-wide
- **Evidence**: Primary value (inter-skill communication via artifacts) has zero format validation at test time
- **Impact**: Format drift between producer and consumer undetectable
- **Suggested action**: Contract tests per artifact in spec format table

#### ⇶ Eval runner gaps — critical (confidence: 85)
- **Location**: `scripts/eval-skills.py:38-49`
- **Evidence**: hej missing from TRIGGER_PROMPTS. Runner checks crashes only, not output correctness.
- **Impact**: Entry-point skill untested; behavioral correctness unverified
- **Suggested action**: Add hej prompt; add output structure checks

#### ⇉ Linter cannot catch semantic correctness — warning (confidence: 90)
- **Location**: `scripts/validate-ecosystem.py`
- **Evidence**: Checks structural presence (sections, keywords) not workflow logic correctness
- **Impact**: Broken instructions pass linter
- **Suggested action**: Accept scope; rely on eval for behavioral coverage

### Version health: B

#### ⇉ CHANGELOG.md [Unreleased] not promoted — warning (confidence: 95)
- **Location**: `CHANGELOG.md:3`
- **Evidence**: Version bump to 1.2.0/1.3.0 already shipped but CHANGELOG still says [Unreleased]
- **Impact**: Consumers believe features are unreleased
- **Suggested action**: Promote to [1.3.0] heading, add empty [Unreleased]

#### ⇢ All 33 version locations consistent — info (confidence: 100)
- **Location**: registry.json, marketplace.json, 11 plugin.json
- **Evidence**: Every version matches across all three sources
- **Impact**: None — excellent alignment

### Dependency health: B

#### ⇉ Prerequisites undocumented — warning (confidence: 90)
- **Location**: `README.md` (absent section)
- **Evidence**: Python 3.10+ required (PEP 604 syntax), claude CLI, git — none listed
- **Impact**: Users hit cryptic errors on older Python
- **Suggested action**: Add Prerequisites section to README

#### ⇉ No minimum Claude Code version — warning (confidence: 85)
- **Location**: absent from all docs
- **Evidence**: Uses worktree isolation, pipe mode, model selection — version-dependent features
- **Impact**: Older CLI versions may fail
- **Suggested action**: Document minimum version

#### ⇉ .gitignore minimal — warning (confidence: 80)
- **Location**: `.gitignore`
- **Evidence**: Missing .env, .DS_Store, editor temp patterns; .planera/ stale entry
- **Impact**: Risk increases with contributors
- **Suggested action**: Add defensive patterns

#### ⇢ Zero third-party imports — info (confidence: 100)
- **Location**: all 12 Python files
- **Evidence**: Every import resolves to stdlib or relative
- **Impact**: None — fully compliant

### Trends vs Audit 3
- **Degraded**: Architecture B→C — broader release-readiness scope exposed LICENSE gap, installation UX, and stale template
- **Stable**: Patterns B→B — inspirera remains the structural outlier (3 of 4 warnings). All Audit 3 findings resolved.
- **New dimensions**: Coupling B, Tests D, Version B, Dependencies B — first assessment
- **Resolved**: All Audit 3 findings (4 warnings, 1 info) cleared. DOCS.md index, hej count, profilera State artifacts, inspirera placement — all fixed.
- **Key risk**: Test health D is the primary blocker for public release confidence. Zero automated coverage for the ecosystem's core value proposition (inter-skill artifact communication).

### Patterns Observed
- inspirera is the persistent structural outlier: three consecutive audits have found pattern deviations. It predates structural conventions and has not been fully normalized.
- Count-staleness pattern appears resolved: linter enforces "eleven-skill" count; no new count errors found.
- Documentation quality follows a gradient: ecosystem-spec.md (authoritative) > SKILL.md files (aligned) > README.md (simplified, drifts). README is the weakest link.
- Python scripts are well-isolated (stdlib-only, narrow interfaces) but completely untested — the classic "it works until it doesn't" pattern.
- The ecosystem is structurally mature (11 skills, shared spec, linter, visual identity, versioning) but lacks the test infrastructure expected for a public release.

---

## Audit 1 — 2026-03-30

**Dimensions assessed**: architecture alignment, pattern consistency
**Findings**: 0 critical, 5 warnings, 6 info (1 downgraded by Decision 4 cross-reference)
**Overall trajectory**: first audit (no prior baseline)
**Grades**: Architecture [B] | Patterns [C]

### Architecture alignment: B

#### "Eight-skill ecosystem" in all SKILL.md files — warning (confidence: 95)
- **Location**: all 8 consuming SKILL.md cross-skill sections
- **Evidence**: every SKILL.md says "part of an eight-skill ecosystem" but suite has 9 skills
- **Impact**: contradicts README and CLAUDE.md which correctly say nine
- **Suggested action**: replace "eight-skill" with "nine-skill" across all SKILL.md files

#### dokumentera doesn't consume PROFILE.md — warning (confidence: 90)
- **Location**: dokumentera/SKILL.md
- **Evidence**: README says PROFILE.md consumed by "all skills"; dokumentera has no profile step
- **Impact**: dokumentera can't calibrate doc style to user preferences
- **Suggested action**: add profile reading to dokumentera's orient steps

#### State artifact consumed-by column understates dependencies — info (confidence: 85)
- **Location**: README.md:46-57
- **Evidence**: VISION.md listed as consumed by 3 skills, actually consumed by 7
- **Suggested action**: update or note table shows primary consumers only

#### DOCS.md Artifact Mapping lacks "Consumed by" — info (confidence: 80)
- **Location**: DOCS.md:19-30
- **Evidence**: has Producers column but no consumer info
- **Suggested action**: consider adding for full dependency visibility

### Pattern consistency: C

#### inspirera missing safety rails section — warning (confidence: 88)
- **Location**: inspirera/SKILL.md
- **Evidence**: 7 of 8 other skills have safety rails with critical tags
- **Impact**: no explicit guardrails on what inspirera must not do
- **Suggested action**: add safety rails section

#### inspirera and profilera missing "Getting started" — warning (confidence: 87)
- **Location**: inspirera/SKILL.md, profilera/SKILL.md
- **Evidence**: 7 of 9 skills have this section
- **Impact**: reduced usability for new users
- **Suggested action**: add getting started sections to both

#### Artifact path resolution wording inconsistencies — warning (confidence: 85)
- **Location**: inspirera/SKILL.md:205, resonera/SKILL.md:49
- **Evidence**: inspirera says "Before writing to" (omits reading), resonera says "cross-skill writes"
- **Suggested action**: standardize to match realisera's canonical pattern

#### Inspirera doesn't reference visionera — warning (confidence: 82)
- **Location**: inspirera/SKILL.md cross-skill section
- **Evidence**: visionera says "informed by /inspirera" but inspirera doesn't mention visionera
- **Suggested action**: add bidirectional reference

#### Planera doesn't acknowledge dokumentera (DTC) — info (confidence: 78)
- **Location**: planera/SKILL.md cross-skill section
- **Evidence**: dokumentera says "feeds /planera" but planera doesn't mention dokumentera
- **Suggested action**: add "Planera is fed by /dokumentera" section

#### State artifacts table header inconsistency — info (confidence: 77)
- **Location**: realisera/SKILL.md:36, inspektera/SKILL.md:37
- **Evidence**: use "File" while others use "Artifact"
- **Suggested action**: standardize column header

### Patterns Observed
- Skills follow consistent macro-structure: frontmatter → intro → state artifacts → steps → safety rails → cross-skill → getting started
- Two outliers (inspirera, profilera) predate later skills and lack structural sections
- Cross-skill references mostly bidirectional with gaps around dokumentera (newest skill)
- Python scripts well-organized and consistently located in scripts/

---

## Audit 2 — 2026-03-31

**Dimensions assessed**: architecture alignment, pattern consistency
**Findings**: 0 critical, 4 warnings, 6 info (4 filtered by confidence)
**Overall trajectory**: improving vs Audit 1
**Grades**: Architecture [B] | Patterns [B]

### Architecture alignment: B

#### CLAUDE.md claims "Ten skills" — warning (confidence: 100)
- **Location**: `CLAUDE.md:5`
- **Evidence**: "Ten skills — each a self-contained SKILL.md" — should be "Eleven skills" after hej addition
- **Impact**: Developers setting up the repo read stale count
- **Suggested action**: Update to "Eleven skills"

#### DOCS.md coverage says 10/10 — warning (confidence: 100)
- **Location**: `DOCS.md:46`
- **Evidence**: `Documented: 10/10 skills have SKILL.md` — should be 11/11
- **Impact**: Self-assessment of documentation coverage is off by one
- **Suggested action**: Update count

#### Some cross-skill references are unidirectional — warning (confidence: 90)
- **Location**: Multiple SKILL.md cross-skill sections
- **Evidence**: inspektera says "feeds /optimera" but optimera doesn't acknowledge reading HEALTH.md. dokumentera feeds planera/realisera but neither acknowledges dokumentera.
- **Impact**: Reading friction — not a logic error, all relationships work correctly
- **Suggested action**: Add reciprocal mentions where missing

#### README state artifacts table shows primary consumers only — info (confidence: 85)
- **Location**: `README.md:52-65`
- **Evidence**: Table shows primary workflow consumers, not the full mesh. Known from Audit 1. By design.

### Pattern consistency: B

#### Resonera has duplicate "Getting started" sections — warning (confidence: 98)
- **Location**: `skills/resonera/SKILL.md:98` and `skills/resonera/SKILL.md:312`
- **Evidence**: Two `## Getting started` headings — first describes workflow initiation, second describes usage patterns. First is misplaced mid-document. All other skills have one section at the end.
- **Impact**: Breaks structural pattern followed by all 10 other skills
- **Suggested action**: Merge into one section at the end

#### Hej artifact path resolution under-specified — info (confidence: 75)
- **Location**: `skills/hej/SKILL.md:50-55`
- **Evidence**: Says "all artifact reads" without listing specific artifacts or noting hej produces nothing. Other skills list explicit examples.

#### Inspirera description differs between registry and marketplace — info (confidence: 100)
- **Location**: `registry.json:7` vs `.claude-plugin/marketplace.json:13`
- **Evidence**: "an external link" (singular, accurate) vs "external links" (plural)

#### Safety rails count varies 5-9 across skills — info (confidence: 65)
- **Location**: All SKILL.md safety rails sections
- **Evidence**: optimera 9, inspirera/profilera 5. Variation likely reflects genuine complexity differences.

#### Resonera is the only skill with a "Personality" section — info (confidence: 60)
- **Location**: `skills/resonera/SKILL.md:73-86`
- **Evidence**: No other skill documents communication personality as a formal section. Makes sense as an exception — resonera's warm Socratic style is central to its function.

### Trends vs Audit 1
- **Improved**: Patterns C→B. All 6 Audit 1 findings (ISS-1 through ISS-6) resolved.
- **Stable**: Architecture remains B. No structural regressions from adding hej.
- **New**: 4 new findings — stale counts (CLAUDE.md, DOCS.md), resonera duplicate section, unidirectional cross-skill refs.
- **Resolved**: ISS-1 through ISS-7 (all prior issues cleared).

### Patterns Observed
- Hej integrates cleanly as a meta-skill — reads all artifacts, produces none, passes all linter checks
- Doc references go stale immediately on skill addition (same pattern as ISS-1). Consider a linter check for count consistency.
- Pushback discipline addition fits tonally with resonera's personality
- Ecosystem handles skill count changes gracefully at the structural level; staleness is purely documentation

---

## Audit 3 — 2026-03-31

**Dimensions assessed**: architecture alignment, pattern consistency
**Findings**: 0 critical, 4 warnings, 1 info (0 filtered by confidence)
**Overall trajectory**: ⮉ improving vs Audit 2
**Grades**: Architecture [B] | Patterns [B]

### Architecture alignment: B

#### README ecosystem diagram omits dokumentera — warning (confidence: 95)
- **Location**: `README.md:27-38`
- **Evidence**: ASCII diagram shows 10 of 11 skills. Dokumentera is absent despite being referenced in the opening line and the state artifacts table. All other skills appear.
- **Impact**: Users don't see how documentation fits the workflow. Visual representation contradicts the "Eleven skills" claim.
- **Suggested action**: Add dokumentera to the diagram as a cross-cutting layer (it's consumed by all skills for DOCS.md path resolution)

#### inspirera artifact path resolution in wrong location — warning (confidence: 100)
- **Location**: `skills/inspirera/SKILL.md:217`
- **Evidence**: Artifact path resolution appears as a subsection of `## Cross-skill integration` instead of under `## State artifacts`. Ecosystem spec Section 5 requires it under State artifacts. inspirera has no State artifacts section at all.
- **Impact**: Violates spec structural requirement. Linter passes because the instruction text exists, but the placement is wrong.
- **Suggested action**: Add `## State artifacts` section to inspirera; move artifact path resolution under it

#### hej cross-skill section has count and list gaps — warning (confidence: 90)
- **Location**: `skills/hej/SKILL.md:227,231`
- **Evidence**: Line 227 says "reads artifacts from all eleven workflow skills" — should be "ten other" (hej doesn't read itself). Line 231 heading says "Reads from all ten skills" but lists only 8 (missing profilera → PROFILE.md, inspirera → no direct artifact but should be acknowledged).
- **Impact**: Incomplete dependency documentation for the entry-point skill
- **Suggested action**: Fix line 227 to "ten other workflow skills", update line 231 list to include profilera and inspirera

### Pattern consistency: B

#### profilera lacks State artifacts section — warning (confidence: 95)
- **Location**: `skills/profilera/SKILL.md`
- **Evidence**: 10 of 11 skills have a `## State artifacts` section with artifact path resolution. profilera is the only one missing it. It reads DECISIONS.md (line 407) and writes PROFILE.md (global path) but documents neither in a structured section.
- **Impact**: Inconsistent structure. profilera's exceptional artifact path (~/.claude/profile/) makes a State artifacts section MORE important, not less — consumers need to know it's not in the project root.
- **Suggested action**: Add State artifacts section documenting PROFILE.md (global), DECISIONS.md (reads via DOCS.md mapping), and artifact path resolution

#### DOCS.md Index missing PLAN.md and self-reference — info (confidence: 100)
- **Location**: `DOCS.md:41-54`
- **Evidence**: Index lists 12 documents but omits PLAN.md (exists at root, active plan) and DOCS.md itself. Both are canonical artifacts in the Artifact Mapping table.
- **Impact**: Index doesn't fully document its own contents
- **Suggested action**: Add both entries to the index

### Trends vs Audit 2
- **Improved**: All Audit 2 findings resolved (ISS-8, ISS-9, ISS-10). Dokumentera Audit 3 fixed 10 additional doc issues. Visual identity system fully deployed. Versioning convention established. Linter updated for eleven-skill count.
- **Stable**: Both grades remain B. Nature of findings shifted from accuracy (wrong counts, missing sections, duplicate content) to structural placement and completeness.
- **New**: 5 new findings (4 warnings, 1 info). 1 introduced by Audit 3 fix (hej "all eleven" should be "ten other"). 4 pre-existing but previously undetected.
- **Resolved**: All Audit 2 findings (ISS-8, ISS-9, ISS-10) cleared.

### Patterns Observed
- Count-staleness pattern persists: three audits have found wrong skill counts (ISS-1 eight→nine, ISS-8 ten→eleven in CLAUDE.md, Audit 3 ten→eleven in SKILL.md/spec). Linter now validates the count, but the linter itself needed manual updating. Consider making the count dynamic (grep skills/ directory).
- Two skills (profilera, inspirera) predate the structural conventions established in later skills. Both lack State artifacts sections that all post-convention skills have.
- Finding quality is improving: Audit 1 found wrong counts and missing safety rails. Audit 2 found stale counts and structural duplicates. Audit 3 finds placement issues and list gaps. Each audit's findings are less severe than the last.
- The ecosystem is settling into a mature pattern: 11 skills, shared spec, linter enforcement, visual identity, versioning convention. Remaining work is polish, not architecture.
