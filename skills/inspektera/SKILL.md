---
name: inspektera
description: >
  INSPEKTERA — Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing —
  Examine, Report, Advise. ALWAYS use this skill for codebase health audits, architecture
  reviews, and structural quality assessments. This skill is REQUIRED whenever the user wants
  to assess the overall health of a codebase, detect architecture drift, find pattern
  inconsistencies, identify complexity hotspots, evaluate test coverage quality, or check
  dependency health. Do NOT attempt codebase-wide quality assessments without this skill — it
  contains the critical workflow for multi-dimensional evaluation, evidence-based findings,
  confidence scoring, and trend tracking that prevents noisy or superficial audits. Trigger on:
  "inspektera", "audit the codebase", "check code health", "architecture review", "find
  technical debt", "assess code quality", "how healthy is this codebase", "what needs fixing",
  "structural review", "pattern audit", "complexity audit", "coupling analysis", "dependency
  check", "test coverage audit", any request to evaluate overall codebase health, any request
  to find structural problems, any request to assess architecture alignment, or when realisera
  has run 5+ cycles without a health check.
---

# INSPEKTERA

**Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing — Examine, Report, Advise**

A codebase health audit that evaluates structural quality across multiple dimensions, produces
evidence-based findings with confidence scores, and tracks trends over time. The retrospective
counterpart to realisera's forward motion — inspektera looks back to assess whether the codebase
is getting better or just getting bigger.

Each invocation = one audit. Findings feed into realisera's work selection via ISSUES.md.

Each audit's output opens with: `─── ⛶ inspektera · audit ───`

---

## State artifacts

Inspektera maintains one file in the project root. Bootstrapped if it doesn't exist.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `HEALTH.md` | Codebase health assessment. Findings, dimension grades, trends. | `# Health\n\n` then the first audit entry. |

The template lives in `references/templates/`. Use it as the starting structure when
bootstrapping — adapt to the project, don't copy verbatim.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (HEALTH.md,
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill reads
(VISION.md, DECISIONS.md, ISSUES.md, PROGRESS.md).

### HEALTH.md

```markdown
## Audit N — YYYY-MM-DD

**Dimensions**: [which dimensions were assessed]
**Findings**: X critical, Y warnings, Z info
**Overall**: ⮉ improving | stable | ⮋ degrading vs prior audit

### [Dimension Name]: [A-F grade]

#### ⇶ [Finding title] — critical (confidence: N/100)
#### ⇉ [Finding title] — warning (confidence: N/100)
#### ⇢ [Finding title] — info (confidence: N/100)
- **Location**: `file:line` (or module/package)
- **Evidence**: [what was observed — quote code, show pattern]
- **Impact**: [why this matters]
- **Suggested action**: [specific fix or investigation]

### Trends
[Comparison with prior audit — what improved, what degraded, what's new]

### Patterns Observed
[De facto architecture patterns extracted from the codebase — the "what IS"]
```

---

## Step 1: Orient

Read the project state to understand context before auditing.

1. **HEALTH.md** — prior audit findings and grades (if exists)
2. **VISION.md** — the intended architecture, principles, and direction (if exists). This is
   the "what SHOULD BE" against which the "what IS" is compared.
3. **DECISIONS.md** — context on why things are the way they are (if exists). Findings that
   contradict a deliberate decision are not findings — they're implementations of that decision.
4. **ISSUES.md** — known problems already tracked (if exists). Don't re-report known issues
   unless they've worsened.
5. **PROGRESS.md** — what was built recently (if exists). Recent changes are higher-priority
   audit targets.
6. **Decision profile** — run the effective profile script for a confidence-weighted summary:
   ```bash
   python3 -m scripts.effective_profile
   ```
   Run from the profilera skill directory (typically
   `~/.claude/plugins/marketplaces/agentera/skills/profilera`).
   Use it to calibrate what "healthy" means for this user — their tolerance for complexity,
   preferred patterns, and quality standards.
   If the script or PROFILE.md is missing, proceed without persona grounding.
7. **Project discovery**:
   - Map the directory structure
   - Read dependency manifests (package.json, go.mod, Cargo.toml, pyproject.toml, etc.)
   - Read README, CLAUDE.md if they exist
   - Identify language, stack, and build/test/lint commands
   - `git log --oneline -20` for recent changes

---

## Step 2: Select dimensions

Choose which health dimensions to assess based on the codebase and user request. Not every
dimension applies to every project — a 200-line CLI tool doesn't need the same audit as a
monorepo.

### Available dimensions

| Dimension | What it evaluates | When to include |
|-----------|-------------------|-----------------|
| **Architecture alignment** | Does the code match the stated architecture? Pattern drift, module boundary violations, layering breaks. | VISION.md or README describes architecture |
| **Pattern consistency** | Are patterns used consistently? Naming, error handling, structure, abstractions. | Any codebase with 5+ modules or files |
| **Coupling health** | Hidden dependencies, circular imports, god modules, inappropriate intimacy. | Any codebase with multiple modules |
| **Complexity hotspots** | Functions too long, deeply nested, high fan-out, accumulated conditionals. | Any codebase |
| **Test health** | Coverage gaps, test quality, test-to-code ratio, tests testing behavior vs implementation. | Project has tests |
| **Dependency health** | Outdated deps, security advisories, unused deps, dep sprawl, pinning discipline. | Project has external dependencies |

**If the user specified dimensions**: audit only those.
**If the user said "full audit" or didn't specify**: auto-select based on the project. Include
all applicable dimensions. Report which you selected and why before proceeding.

---

## Step 3: Assess

Launch parallel agents — one per selected dimension. Each agent receives:

- The dimension definition and what to look for (from this skill's descriptions below)
- Language-specific audit commands from `references/audit-commands.md` — read the relevant
  language sections and include the concrete commands for the project's stack
- Relevant context files (VISION.md for architecture alignment, dependency manifests for
  dependency health, etc.)
- The confidence scoring rubric
- Instructions to return structured findings

**Before deep analysis**: run the quick checklist from `references/audit-commands.md` for a
rapid pass/fail sweep. Dimensions that pass all checklist items can be audited at lower priority.

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
- Known issues already tracked in ISSUES.md
- Intentional decisions documented in DECISIONS.md
```

### Architecture alignment

Evaluate how well the codebase matches its stated architecture:

- Read VISION.md (or README's architecture section) for the intended structure
- Map the actual module boundaries, dependency graph, and data flow
- Identify drift: where the code has diverged from the stated architecture
- Check layering: do higher-level modules depend on lower-level ones correctly?
- Check boundaries: are module interfaces clean, or do internals leak?
- Extract "Patterns Observed" — the de facto architecture, independent of what's stated

If no architecture is documented, extract and report the de facto architecture. Note the
absence of documentation as a finding.

### Pattern consistency

Evaluate whether patterns are used consistently across the codebase:

- Error handling: is it consistent? (returns vs throws vs error types)
- Naming: do similar things have similar names? (singular vs plural, prefixes, casing)
- Structure: do similar modules have similar layouts?
- Abstractions: are there competing abstractions for the same concept?
- DRY: is there duplicated logic that should be shared?
- Configuration: is config handled consistently? (env vars vs files vs flags)

Focus on inconsistencies between similar things, not on whether the chosen pattern is "best."

### Coupling health

Evaluate module coupling and dependency structure:

- Map import graphs — which modules depend on which?
- Identify circular dependencies
- Find god modules (too many dependents or dependencies)
- Check for inappropriate intimacy (modules reaching into each other's internals)
- Evaluate interface width — are module boundaries narrow or do they expose everything?
- Check for hidden coupling through shared mutable state, global config, or side effects

Use language-appropriate tools: Go has `go list`, Node has `madge`, Python has import analysis.
If tools aren't available, trace imports manually on the highest-risk modules.

### Complexity hotspots

Identify where complexity is accumulating:

- Long functions (language-dependent thresholds, but generally 50+ lines is worth flagging)
- Deep nesting (3+ levels of conditionals or loops)
- High fan-out (functions calling many other functions)
- Switch/match statements that keep growing
- Functions with many parameters (5+)
- Files that keep growing cycle over cycle (check git history)

Prioritize hotspots that are also high-change files (frequently modified + complex = high risk).

### Test health

Evaluate the quality and coverage of the test suite:

- Run coverage if the project has a coverage tool, otherwise estimate from file analysis
- Identify critical paths with no test coverage
- Check test quality: are tests testing behavior or testing implementation?
- Look for test antipatterns: excessive mocking, brittle assertions, tests that test nothing
- Evaluate test naming: can you understand what failed from the test name alone?
- Check test-to-code ratio for each major module

Don't just report a coverage number — identify the *highest-risk* coverage gaps.

### Dependency health

Evaluate external dependency management:

- Check for outdated dependencies (use package manager's audit/outdated commands)
- Check for known security vulnerabilities (npm audit, safety check, govulncheck, etc.)
- Identify unused dependencies (installed but not imported)
- Evaluate dep sprawl: are there too many deps for what the project does?
- Check pinning discipline: are versions pinned or floating?
- Look for vendored vs remote: is the approach consistent?

---

## Step 4: Synthesize

After all agents complete:

1. **Filter by confidence** — discard findings below 50. Findings 50-69 are marked as "info"
   regardless of their apparent severity.
2. **Deduplicate** — multiple dimensions may flag the same underlying issue. Merge using a
   three-tier preference: (1) keep the finding with the fullest context (the one that
   explains the most about the issue), (2) if context is comparable, prefer the finding
   from the most evidence-rich dimension, (3) if still tied, prefer the most recent.
   Preserve complementary evidence from discarded findings as additional context in the
   merged entry rather than dropping it entirely.
3. **Cross-reference** — check findings against DECISIONS.md and ISSUES.md:
   - If a finding matches a known decision → discard or downgrade to info with a note
   - If a finding matches a known issue → note "already tracked" and skip
   - If a finding is genuinely new → include at full severity
4. **Grade each dimension** — assign a letter grade based on findings:
   - **A**: No critical or warning findings. Healthy.
   - **B**: No critical findings. Some warnings. Solid with room for improvement.
   - **C**: 1-2 critical findings or many warnings. Needs attention.
   - **D**: Multiple critical findings. Structural problems.
   - **F**: Pervasive critical findings. Health crisis.
5. **Detect trends** — if prior HEALTH.md exists, compare:
   - Dimensions that improved (grade went up or findings resolved)
   - Dimensions that degraded (grade went down or new findings)
   - Dimensions that are stable (same grade, similar findings)
   - Calculate overall trajectory: improving / stable / degrading

---

## Step 5: Report

Write the audit results to `HEALTH.md` (append new audit, keep prior audits for trend history)
and present to the user.

### Report structure

```markdown
## Audit N — YYYY-MM-DD

**Dimensions assessed**: [list]
**Findings**: X critical, Y warnings, Z info (N filtered by confidence)
**Overall trajectory**: ⮉ improving | stable | ⮋ degrading vs Audit N-1
**Grades**: Architecture [B] | Patterns [A] | Coupling [C] | Complexity [B] | Tests [D] | Deps [A]

### [Dimension Name]: [Grade]

#### ⇶ [Finding title] — critical (confidence: N/100)
#### ⇉ [Finding title] — warning (confidence: N/100)
#### ⇢ [Finding title] — info (confidence: N/100)
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
[De facto architecture patterns extracted — the "what IS" independent of what's stated.
This section helps realisera and resonera understand the current reality.]
- Module structure: [how code is organized]
- Error handling: [predominant pattern]
- Testing approach: [how tests are structured]
- Dependency patterns: [how deps are managed]
```

---

## Step 6: Connect

Feed actionable findings into the rest of the suite:

1. **ISSUES.md** — for each critical finding not already tracked, offer to add an issue entry
   under the `## Open` section. Use severity mapping: critical finding → `critical` severity,
   warning → `degraded`, info → `annoying`. Present the list and get user confirmation before
   writing.
2. **VISION.md** — if architecture alignment reveals the stated architecture is outdated (the
   code has intentionally evolved past it), suggest updating VISION.md via `/resonera` to
   deliberate on the new direction.
3. **Present findings to the user** with a summary and ask if they want to:
   - File findings to ISSUES.md for realisera to pick up
   - Deliberate on structural decisions via `/resonera`
   - Deep-dive on a specific dimension
   - Investigate a specific finding in more detail

---

## Safety rails

<critical>

- NEVER modify code. Inspektera audits; other skills fix.
- NEVER file issues to ISSUES.md without explicit user confirmation.
- NEVER present speculative findings (confidence < 50) as definitive problems.
- NEVER ignore DECISIONS.md context. If a finding contradicts a deliberate decision,
  it is not a finding — it's an implementation of that decision. Discard or downgrade.
- NEVER report known issues already tracked in ISSUES.md as new findings.
- NEVER flag subjective style preferences as findings unless they violate stated principles
  in VISION.md, CLAUDE.md, or the decision profile.
- NEVER run destructive commands or install packages. Read-only assessment.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — All selected audit dimensions were assessed, findings were synthesized, grades were assigned, HEALTH.md was updated, and the user was presented with actionable results.
- **flagged** — The audit completed but with notable caveats: one or more dimensions had to be skipped due to missing tooling, confidence was too low to grade a dimension reliably, or critical findings were discovered that require urgent attention beyond the audit scope.
- **stuck** — Cannot complete the audit because the project is inaccessible, required language tooling is unavailable and manual analysis is not feasible, or filing findings to ISSUES.md was declined by the user and the results cannot be safely surfaced any other way.
- **waiting** — The audit target is ambiguous: no project was identified, the codebase is too incomplete to assess meaningfully, or the user's request specifies dimensions that cannot be evaluated without additional information.

---

## Cross-skill integration

Inspektera is part of a ten-skill ecosystem. It is the feedback loop — the skill that tells
realisera whether its work is making things better.

### Inspektera feeds /realisera
Critical and warning findings filed to ISSUES.md become candidates for realisera's work
selection. The severity mapping ensures structural problems compete fairly with feature work.
The "Patterns Observed" section helps realisera understand the codebase's de facto architecture
when planning changes.

### Inspektera feeds /resonera
When the audit reveals architectural drift or structural decisions that need deliberation —
the code has evolved past the stated architecture, or competing patterns suggest a design
choice is needed — suggest `/resonera` to think it through before anyone starts fixing.

### Inspektera feeds /planera
When the audit reveals multiple related structural issues, suggest `/planera` to create a
remediation plan. The plan's acceptance criteria give inspektera concrete targets to verify
in the next audit.

### Inspektera feeds /optimera
When a dimension grade is poor and the improvement is measurable (test coverage, dependency
count, complexity score), the finding can become an optimization objective. Suggest `/optimera`
when the metric and direction are clear.

### Inspektera reads /realisera output
PROGRESS.md tells inspektera what was built recently — recent changes are higher-priority
audit targets because they're the most likely source of regressions or pattern breaks. Cycle
count since last audit signals when a health check is overdue.

### Inspektera reads /resonera output
DECISIONS.md explains why things are the way they are. Findings that contradict deliberate
decisions are not findings. This prevents inspektera from flagging intentional tradeoffs as
problems.

### Inspektera reads /visualisera output
DESIGN.md provides visual identity constraints that inspektera can audit for consistency —
checking whether the codebase respects the declared design tokens and patterns.

### Inspektera is informed by /profilera
The decision profile calibrates what "healthy" means for this user. A user who values
simplicity over flexibility will have different complexity thresholds than one who values
extensibility. High-confidence quality preferences from the profile weight the grading.

---

## Getting started

### First audit

1. `/inspektera` — runs a full audit across all applicable dimensions, bootstraps HEALTH.md
2. Review findings, file critical ones to ISSUES.md
3. `/realisera` — next cycle picks up the filed issues and starts fixing

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
- **Poor grades (D/F)**: Consider pausing feature work. Use `/resonera` to deliberate on
  priorities, then `/realisera` to fix the structural problems before building more.
