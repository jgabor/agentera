---
name: inspektera
description: >
  INSPEKTERA (Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing; Examine, Report, Advise). ALWAYS use this skill for codebase health audits, architecture reviews, and structural quality assessments. This skill is REQUIRED whenever the user wants to assess the overall health of a codebase, detect architecture drift, find pattern inconsistencies, identify complexity hotspots, evaluate test coverage quality, or check dependency health. Do NOT attempt codebase-wide quality assessments without this skill because it contains the critical workflow for multi-dimensional evaluation, evidence-based findings, confidence scoring, and trend tracking that prevents noisy or superficial audits. Trigger on: "inspektera", "audit the codebase", "check code health", "architecture review", "find technical debt", "assess code quality", "how healthy is this codebase", "what needs fixing", "structural review", "pattern audit", "complexity audit", "coupling analysis", "dependency check", "test coverage audit", any request to evaluate overall codebase health, any request to find structural problems, any request to assess architecture alignment, or when realisera has run 5+ cycles without a health check.
---

# INSPEKTERA

**Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing. Examine, Report, Advise.**

Codebase health audit: multi-dimensional structural quality evaluation with evidence-based findings, confidence scores, and trend tracking. The retrospective counterpart to realisera's forward motion: is the codebase getting better or just bigger?

Each invocation = one audit. Findings feed realisera's work selection via TODO.md. Skill introduction: `─── ⛶ inspektera · audit ───`

---

## State artifacts

One file in `.agentera/`, bootstrapped if absent.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `HEALTH.md` | Codebase health assessment. Findings, dimension grades, trends. | `# Health\n\n` then the first audit entry. |

Template in `references/templates/`. Use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (.agentera/HEALTH.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact references in this skill, including cross-skill reads (VISION.md, .agentera/DECISIONS.md, TODO.md, .agentera/PROGRESS.md).

### HEALTH.md

Open with your read on the codebase before the structured data: what's improving, what's sliding, what surprised you. 1-2 sentences of interpretation, then the grades and findings back it up. The colleague says what they think, then shows the evidence.

```markdown
## Audit N · YYYY-MM-DD

**Dimensions**: [which dimensions were assessed]
**Findings**: X critical, Y warnings, Z info
**Overall**: ⮉ improving | stable | ⮋ degrading vs prior audit

### [Dimension Name]: [A-F grade]

#### ⇶ [Finding title], critical (confidence: N/100)
#### ⇉ [Finding title], warning (confidence: N/100)
#### ⇢ [Finding title], info (confidence: N/100)
- **Location**: `file:line` (or module/package)
- **Evidence**: [what was observed: quote code, show pattern]
- **Impact**: [why this matters]
- **Suggested action**: [specific fix or investigation]

### Trends
[Comparison with prior audit: what improved, what degraded, what's new]

### Patterns Observed
[De facto architecture patterns extracted from the codebase, the "what IS"]
```

---

Step markers: display `── step N/6: verb` before each step.
Steps: orient, select, assess, distill, report, connect.

## Step 1: Orient

Read HEALTH.md, TODO.md, and PROGRESS.md in parallel. These reads are independent; issue all in a single response.

1. **HEALTH.md**: prior audit findings and grades (if exists)
2. **VISION.md**: the "what SHOULD BE" against which "what IS" is compared (if exists)
3. **DECISIONS.md**: why things are the way they are (if exists). Findings contradicting deliberate decisions are not findings.
4. **TODO.md**: known problems (if exists). Don't re-report unless worsened.
5. **PROGRESS.md**: last 3 cycle entries only (recent changes = higher-priority audit targets)
5b. **Change magnitude**: if PROGRESS.md has commit hashes from cycles since the last HEALTH.md audit date, run `git log --stat` on those commits to estimate total change volume (files touched, lines changed). If no PROGRESS.md or no commit hashes, skip; default depth applies.
6. **Decision profile**: run from the profilera skill directory:
   ```bash
   python3 scripts/effective_profile.py
   ```
   Calibrates what "healthy" means for this user. If missing, proceed without persona grounding.
7. **Project discovery**: map directory structure, read dependency manifests, README, CLAUDE.md, identify language/stack/build commands, `git log --oneline -20`

Before proceeding: in your response, list the key structural facts (module boundaries, dependency patterns, test coverage gaps) you observed. These survive context compaction.

**Exit-early guard**: If `git diff` since the last HEALTH.md update shows no file changes, report exit signal `complete: no changes since last audit` and stop.

---

## Step 2: Select dimensions

Choose dimensions based on the codebase and user request. Not every dimension applies; a 200-line CLI doesn't need the same audit as a monorepo.

### Available dimensions

| Dimension | What it evaluates | When to include |
|-----------|-------------------|-----------------|
| **Architecture alignment** | Does the code match the stated architecture? Pattern drift, module boundary violations, layering breaks. | VISION.md or README describes architecture |
| **Pattern consistency** | Are patterns used consistently? Naming, error handling, structure, abstractions. | Any codebase with 5+ modules or files |
| **Coupling health** | Hidden dependencies, circular imports, god modules, inappropriate intimacy. | Any codebase with multiple modules |
| **Complexity hotspots** | Functions too long, deeply nested, high fan-out, accumulated conditionals. | Any codebase |
| **Test health** | Coverage gaps, test quality, test-to-code ratio, tests testing behavior vs implementation. | Project has tests |
| **Dependency health** | Outdated deps, security advisories, unused deps, dep sprawl, pinning discipline. | Project has external dependencies |
| **Version health** | Unreleased significant changes: `feat`/`fix` commits since the last version bump. | DOCS.md has a `versioning` convention block |

### Depth guidance

When change magnitude was derived in Step 1, apply advisory depth scaling:

- **Light changes** (roughly ≤5 files, ≤200 lines since last audit): prioritize dimensions most relevant to the changed areas. Skip dimensions with no intersection.
- **Standard changes** (default): assess all applicable dimensions at normal depth.
- **Heavy changes** (roughly ≥20 files or architectural-scope commits): assess all applicable dimensions and increase evidence collection depth. Read more files per dimension, trace more dependency paths, check more edge cases.

These thresholds are guidelines, not hard rules. Use judgment: a 6-file change touching a critical security module warrants thorough depth, while a 25-file rename is light.

**User specified dimensions**: audit only those.
**Full audit or unspecified**: auto-select all applicable. Report selections before proceeding.

---

## Step 3: Assess

Lead the assessment with your overall interpretation: what stands out, what's changed, where attention should go. Then the per-dimension breakdown provides the evidence.

Launch parallel agents, one per dimension. Each receives the dimension definition, language-specific commands from `references/audit-commands.md`, relevant context files, the confidence scoring rubric, and instructions to return structured findings.

**Before deep analysis**: run the `references/audit-commands.md` quick checklist for a rapid pass/fail sweep. Dimensions passing all items can be audited at lower priority.

```
You are auditing the [dimension] health of [project].

## What to evaluate
[Dimension-specific instructions from below]

## Evidence standard
Every finding MUST include:
- Specific file and line references
- Quoted code showing the issue
- Explanation of why it matters
- Confidence score (0-100)

## Presenting findings
Introduce each finding conversationally before the structured evidence. The colleague
says "hey, I noticed this" instead of just dumping a finding card. Lead with why it caught your eye and what it means, then back it up with the evidence block.

## Confidence scoring
- 90-100: Definitely a real issue. Verified by reading the code. Clear impact.
- 70-89: Very likely a real issue. Strong evidence, but some context might justify it.
- 50-69: Possibly an issue. The pattern is suspicious but could be intentional.
- 30-49: Uncertain. Might be an issue, might be a reasonable tradeoff.
- 0-29: Speculative. Flagging it but wouldn't be surprised if it's fine.

## What is NOT a finding
- Pre-existing patterns that are consistent and deliberate
- Things a linter or type checker would catch (assume CI handles those)
- Subjective style preferences not grounded in stated project principles
- Known issues already tracked in TODO.md
- Intentional decisions documented in DECISIONS.md
```

### Architecture alignment

Compare codebase to stated architecture:

- Read VISION.md (or README architecture section) for intended structure
- Map actual module boundaries, dependency graph, data flow
- Identify drift from stated architecture
- Check layering and boundary cleanliness
- Extract "Patterns Observed": de facto architecture independent of documentation

No documented architecture? Extract and report de facto; note absence as a finding.

### Pattern consistency

Check consistency across the codebase:

- Error handling (returns vs throws vs error types)
- Naming (singular vs plural, prefixes, casing)
- Module structure and layout similarity
- Competing abstractions for the same concept
- Duplicated logic that should be shared
- Config handling (env vars vs files vs flags)

Focus on inconsistencies between similar things, not whether the chosen pattern is "best."

### Coupling health

Evaluate coupling and dependency structure:

- Map import graphs, identify circular dependencies
- Find god modules (too many dependents or dependencies)
- Check for inappropriate intimacy (reaching into internals)
- Evaluate interface width: narrow boundaries or exposing everything?
- Check hidden coupling via shared mutable state, global config, side effects

Use language tools (`go list`, `madge`, import analysis). If unavailable, trace imports manually on highest-risk modules.

### Complexity hotspots

Find accumulating complexity:

- Long functions (generally 50+ lines), deep nesting (3+ levels)
- High fan-out, growing switch/match statements, many parameters (5+)
- Files growing cycle over cycle (check git history)

Prioritize high-change files: frequently modified + complex = high risk.

### Test health

Evaluate test suite quality and coverage:

- Run coverage tools if available, otherwise estimate from file analysis
- Identify critical paths with no coverage
- Check: testing behavior or implementation? Excessive mocking? Brittle assertions?
- Evaluate test naming: can you understand what failed from the name alone?
- Check test-to-code ratio per major module

Don't just report a number. Identify the *highest-risk* coverage gaps.

### Dependency health

Evaluate dependency management:

- Outdated deps (package manager audit/outdated commands)
- Known security vulnerabilities (npm audit, safety check, govulncheck)
- Unused deps (installed but not imported)
- Dep sprawl relative to project scope
- Pinning discipline (pinned or floating?)
- Vendored vs remote consistency

### Version health

Only run this dimension if DOCS.md exists and contains a `versioning` convention block. Skip entirely if the convention is absent.

- Read DOCS.md `Conventions.versioning` to identify the version file(s) and bump trigger rules
- Run `git log --oneline` to find `feat` and `fix` commits since the last modification date of the version file(s) (`git log --follow -- <version-file>` gives the timestamp of the last bump)
- Count unbumped `feat`/`fix` commits and note the age of the oldest one
- Severity: warning if 1–4 unbumped commits or age ≤ 7 days; critical if 5+ unbumped commits or age > 7 days
- If no `feat`/`fix` commits have landed since the last bump, this dimension is healthy with no finding

---

## Step 4: Distill

After all agents complete:

1. **Filter**: discard findings below 50 confidence. Mark 50-69 as "info" regardless of apparent severity.
2. **Deduplicate**: merge by preference: (1) fullest context, (2) most evidence-rich dimension, (3) most recent. Preserve complementary evidence from discarded findings.
3. **Cross-reference** against DECISIONS.md and TODO.md:
   - Matches known decision → discard or downgrade to info
   - Matches known issue → "already tracked", skip
   - Genuinely new → include at full severity
4. **Grade** each dimension:
   - **A**: No critical/warning findings. **B**: No critical, some warnings.
   - **C**: 1-2 critical or many warnings. **D**: Multiple critical.
   - **F**: Pervasive critical findings.
5. **Trends**: compare to prior HEALTH.md: improved, degraded, stable dimensions. Calculate overall trajectory: improving / stable / degrading.

---

## Step 5: Report

Assess each dimension in your response. Write ONLY grade, trend indicator, and ≤30-word finding per dimension to HEALTH.md. No reasoning in the artifact; the conversation preserves analysis, the artifact preserves conclusions.

Output constraint: ≤30 words per finding description, ≤15 words per recommendation. Letter grade + ≤3 sentences justification per dimension.

When updating existing HEALTH.md entries (e.g., updating Patterns Observed), use the Edit tool on the specific section rather than rewriting the file. Append new audit entries.

Write the audit results to `HEALTH.md` (append new audit, keep prior audits for trend history) and present to the user.

### Report structure

```markdown
## Audit N · YYYY-MM-DD

**Dimensions assessed**: [list]
**Findings**: X critical, Y warnings, Z info (N filtered by confidence)
**Overall trajectory**: ⮉ improving | stable | ⮋ degrading vs Audit N-1
**Grades**: Architecture [B] | Patterns [A] | Coupling [C] | Complexity [B] | Tests [D] | Deps [A]

### [Dimension Name]: [Grade]

#### ⇶ [Finding title], critical (confidence: N/100)
#### ⇉ [Finding title], warning (confidence: N/100)
#### ⇢ [Finding title], info (confidence: N/100)
- **Location**: `file:line` (or module/package)
- **Evidence**: [quoted code or structural observation]
- **Impact**: [what breaks, degrades, or risks]
- **Suggested action**: [specific fix, investigation, or refactor]

[Repeat for each finding, ordered by severity then confidence]

### Trends vs Audit N-1
- **Improved**: [what got better and why (e.g., "Coupling [D→C]: circular dep in auth/ resolved in cycle 12")]
- **Degraded**: [what got worse and why]
- **New findings**: [issues not present in prior audit]
- **Resolved**: [prior findings no longer present]

### Patterns Observed
[De facto architecture patterns extracted, the "what IS" independent of what's stated.
This section helps realisera and resonera understand the current reality.]
- Module structure: [how code is organized]
- Error handling: [predominant pattern]
- Testing approach: [how tests are structured]
- Dependency patterns: [how deps are managed]
```

---

## Step 6: Connect

Feed actionable findings into the ecosystem:

1. **TODO.md**: for each critical finding not already tracked, offer to add under the appropriate severity section.
   Severity mapping: critical → `## ⇶ Critical`, warning → `## ⇉ Degraded`, info → `## ⇢ Annoying`. Each entry is a checkbox line: `- [ ] [finding description]`. Get user confirmation before writing.
   Output constraint: ≤30 words per issue description.
2. **VISION.md**: if architecture has intentionally evolved past stated architecture, suggest updating via `/resonera`.
3. **Present findings** and ask if the user wants to: file to TODO.md, deliberate via `/resonera`, deep-dive on a dimension, or investigate a specific finding.

---

## Safety rails

<critical>

- NEVER modify code. Inspektera audits; other skills fix.
- NEVER file issues to TODO.md without explicit user confirmation.
- NEVER present speculative findings (confidence < 50) as definitive problems.
- NEVER ignore DECISIONS.md context. If a finding contradicts a deliberate decision,
  it is not a finding but an implementation of that decision. Discard or downgrade.
- NEVER report known issues already tracked in TODO.md as new findings.
- NEVER flag subjective style preferences as findings unless they violate stated principles
  in VISION.md, CLAUDE.md, or the decision profile.
- NEVER run destructive commands or install packages. Read-only assessment.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ⛶ inspektera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: All selected audit dimensions were assessed, findings were synthesized, grades were assigned, HEALTH.md was updated, and the user was presented with actionable results.
- **flagged**: The audit completed but with notable caveats: one or more dimensions had to be skipped due to missing tooling, confidence was too low to grade a dimension reliably, or critical findings were discovered that require urgent attention beyond the audit scope.
- **stuck**: Cannot complete the audit because the project is inaccessible, required language tooling is unavailable and manual analysis is not feasible, or filing findings to TODO.md was declined by the user and the results cannot be safely surfaced any other way.
- **waiting**: The audit target is ambiguous: no project was identified, the codebase is too incomplete to assess meaningfully, or the user's request specifies dimensions that cannot be evaluated without additional information.

---

## Cross-skill integration

Inspektera is part of an eleven-skill ecosystem. It is the feedback loop, the skill that tells realisera whether its work is making things better.

### Inspektera feeds /realisera
Critical and warning findings filed to TODO.md become candidates for realisera's work selection. The severity mapping ensures structural problems compete fairly with feature work. The "Patterns Observed" section helps realisera understand the codebase's de facto architecture when planning changes.

### Inspektera feeds /resonera
When the audit reveals architectural drift or structural decisions that need deliberation (the code has evolved past the stated architecture, or competing patterns suggest a design choice is needed), suggest `/resonera` to think it through before anyone starts fixing.

### Inspektera feeds /planera
When the audit reveals multiple related structural issues, suggest `/planera` to create a remediation plan. The plan's acceptance criteria give inspektera concrete targets to verify in the next audit.

### Inspektera feeds /optimera
When a dimension grade is poor and the improvement is measurable (test coverage, dependency count, complexity score), the finding can become an optimization objective. Suggest `/optimera` when the metric and direction are clear.

### Inspektera reads /realisera output
PROGRESS.md tells inspektera what was built recently. Recent changes are higher-priority audit targets because they're the most likely source of regressions or pattern breaks. Cycle count since last audit signals when a health check is overdue.

### Inspektera reads /resonera output
DECISIONS.md explains why things are the way they are. Findings that contradict deliberate decisions are not findings. This prevents inspektera from flagging intentional tradeoffs as problems.

### Inspektera reads /visualisera output
DESIGN.md provides visual identity constraints that inspektera can audit for consistency, checking whether the codebase respects the declared design tokens and patterns.

### Inspektera is informed by /profilera
The decision profile calibrates what "healthy" means for this user. A user who values simplicity over flexibility will have different complexity thresholds than one who values extensibility. High-confidence quality preferences from the profile weight the grading.

---

## Getting started

### First audit

1. `/inspektera`: runs a full audit across all applicable dimensions, bootstraps HEALTH.md
2. Review findings, file critical ones to TODO.md
3. `/realisera`: next cycle picks up the filed issues and starts fixing

### Periodic health checks

Run `/inspektera` every 5-10 realisera cycles, or when:
- A major feature was added
- Significant refactoring occurred
- The codebase "feels" harder to work in
- Before a major architectural decision (to understand current state)

### Targeted audits

```
/inspektera architecture coupling
```

Specify dimensions to narrow the audit scope. Useful after specific kinds of changes.

### After an audit

- **Good grades (A/B)**: Celebrate. Keep building.
- **Mixed grades (C)**: File the critical findings, deliberate on the warnings.
- **Poor grades (D/F)**: Consider pausing feature work. Use `/resonera` to deliberate on priorities, then `/realisera` to fix the structural problems before building more.
