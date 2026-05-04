# INSPEKTERA

**Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing. Examine, Report, Advise.**

Codebase health audit: multi-dimensional structural quality evaluation with evidence-based findings, confidence scores, and trajectory tracking. The retrospective counterpart to realisera's forward motion: is the codebase getting better or just bigger?

Each invocation = one audit. Findings feed realisera's work selection via TODO.md. Skill introduction: `─── ⛶ inspektera · audit ───`

---

## Visual identity

Glyph: **⛶** (protocol ref: SG3). Used in the mandatory exit marker.

---

## State artifacts

One file in `.agentera/`, bootstrapped if absent.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `HEALTH.md` | Codebase health assessment. Findings, dimension grades, trajectory. | `# Health\n\n` then the first audit entry. |

Template in `references/templates/` (at v1 skill location `skills/inspektera/references/templates/`). Use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/DOCS.md` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/DOCS.md` doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in `.agentera/`. This applies to all artifact references in this capability, including cross-capability reads (VISION.md, `.agentera/DECISIONS.md`, TODO.md, `.agentera/PROGRESS.md`).

### Contract

Before starting, read `references/contract.md` (at v1 skill location `skills/inspektera/references/contract.md`) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the contract takes precedence.

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

Step markers: display `── step N/7: verb` before each step.
Steps: orient, select, assess, distill, audit, report, connect.

## Step 1: Orient

Read HEALTH.md, TODO.md, and PROGRESS.md in parallel. These reads are independent; issue all in a single response.

1. **HEALTH.md**: prior audit findings and grades (if exists)
2. **VISION.md**: the "what SHOULD BE" against which "what IS" is compared (if exists)
3. **DECISIONS.md**: why things are the way they are (if exists). Findings contradicting deliberate decisions are not findings.
4. **TODO.md**: known problems (if exists). Don't re-report unless worsened.
5. **PROGRESS.md**: last 3 cycle entries only (recent changes = higher-priority audit targets)
5b. **Change magnitude**: if PROGRESS.md has commit hashes from cycles since the last HEALTH.md audit date, run `git log --stat` on those commits to estimate total change volume. If no PROGRESS.md or no commit hashes, skip; default depth applies.
5c. **Plan context** (for artifact freshness): if PLAN.md exists, read its metadata comment for the `Created` date and scan task statuses for dispatched capabilities. This provides the plan-relative staleness baseline for the Artifact freshness dimension. If PLAN.md is absent or has no `Created` date, note that plan context is unavailable; the fallback heuristic will apply.
6. **Decision profile**: run from the profilera skill directory:

   ```bash
   python3 scripts/effective_profile.py <!-- platform: profile-path -->
   ```

   Calibrates what "healthy" means for this user per contract profile consumption conventions. If missing, proceed without persona grounding.
7. **Project discovery**: map directory structure, read dependency manifests, README, CLAUDE.md, AGENTS.md, identify language/stack/build commands, `git log --oneline -20`

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
| **Artifact freshness** | Are state artifacts current relative to plan activity or recent development? Detects artifacts that should have been updated but weren't. | Plan context available (PLAN.md with `Created` date) or PROGRESS.md has entries |
| **Prose health** | Do artifact entries respect the writing rules? Checks verbosity drift, abstraction creep, and filler accumulation across all project artifacts. | Project has 3+ artifact files |
| **Security hygiene** | Hardcoded secrets, dangerous function calls, basic injection patterns. Lightweight regex-based scan, not a replacement for dedicated security tooling. | Any codebase |

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

Launch parallel agents, one per dimension. Each receives the dimension definition, language-specific commands from `references/audit-commands.md` (at v1 skill location `skills/inspektera/references/audit-commands.md`), relevant context files, the confidence scoring rubric, and instructions to return structured findings.

**Before deep analysis**: run the quick checklist for a rapid pass/fail sweep. Dimensions passing all items can be audited at lower priority.

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

## Confidence scoring (protocol: CS1-CS5)
- 90-100 (CS1): Definitely a real issue. Verified by reading the code. Clear impact.
- 70-89 (CS2): Very likely a real issue. Strong evidence, but some context might justify it.
- 50-69 (CS3): Possibly an issue. The pattern is suspicious but could be intentional.
- 30-49 (CS4): Uncertain. Might be an issue, might be a reasonable tradeoff.
- 0-29 (CS5): Speculative. Flagging it but wouldn't be surprised if it's fine.

## What is NOT a finding
- Pre-existing patterns that are consistent and deliberate
- Things a linter or type checker would catch (assume CI handles those)
- Subjective style preferences not grounded in stated project principles
- Known issues already tracked in TODO.md
- Intentional decisions documented in DECISIONS.md
```

### Architecture alignment

Compare codebase to stated architecture:

- Read VISION.md (or README.md architecture section) for intended structure
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
- Check test proportionality against contract: default is one pass + one fail per testable unit. Flag under-testing and over-testing.

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
- Run `git log --oneline` to find `feat` and `fix` commits since the last modification date of the version file(s)
- Count unbumped `feat`/`fix` commits and note the age of the oldest one
- Severity: warning (SF2) if 1-4 unbumped commits or age ≤ 7 days; critical (SF1) if 5+ unbumped commits or age > 7 days
- If no `feat`/`fix` commits have landed since the last bump, this dimension is healthy with no finding

### Artifact freshness

Evaluates whether state artifacts are current relative to plan activity or recent development. Uses the staleness convention from contract.

**With plan context** (PLAN.md has a `Created` date and task execution history):

- Read the plan's `Created` date from its HTML comment metadata
- Identify which capabilities were dispatched during the plan by scanning task entries and PROGRESS.md cycle logs
- For each dispatched capability, look up its expected artifacts in the contract staleness detection mapping
- Check each expected artifact's last modification date: `git log -1 --format=%aI -- <path>`
- An artifact is **stale** if its last modification predates the plan's creation date AND the capability that owns it was dispatched at least once during the plan
- Severity: warning (SF2, confidence 70+). Plan-relative staleness carries causal evidence.
- Artifacts that a capability reads but does not produce are not staleness candidates

**Without plan context** (no PLAN.md, or PLAN.md has no `Created` date):

- Fall back to PROGRESS.md recency: an artifact is potentially stale if it was not modified since the most recent PROGRESS.md cycle entry date
- If PROGRESS.md has no entries (fresh project), no staleness check applies
- Severity: info (SF3, confidence 50-60). The fallback is advisory, not authoritative.

**Handling**: stale artifact findings are reported like any other dimension finding but noted as context for the next plan cycle, not as blocking errors.

### Prose health

Evaluate artifact prose quality against the three Self-Audit Protocol rules. Read all project artifacts (PROGRESS.md, DECISIONS.md, PLAN.md, HEALTH.md, TODO.md, CHANGELOG.md, VISION.md, DESIGN.md, DOCS.md) and check each entry.

**Rule 1: Verbosity drift**: approximate word count per entry. Compare against per-entry budgets. Entries exceeding their budget by 50%+ are findings.

**Rule 2: Abstraction creep**: scan each entry for ≥1 concrete anchor (file path with extension, line number, commit hash with 7+ hex chars, metric value with unit, identifier such as function/class/variable name, direct quote in quotes attributed to a source). Entries with zero concrete anchors are findings.

**Rule 3: Filler accumulation**: scan each entry against banned verbosity patterns. Flag entries containing: meta-commentary about writing, hedging qualifiers, redundant transitions, self-referential process narration, filler introductions, summary preambles, excessive justification.

### Security hygiene

Lightweight regex-based scan for common security anti-patterns. This is a surface-level check, not a replacement for dedicated security analysis. Always recommend specialized tools for comprehensive coverage.

**What to scan**:

- **Hardcoded secrets**: API key patterns, password assignments, token strings in source, private keys in files
- **Dangerous function calls**: `eval()` on variables or user input, `exec()` with string concatenation, subprocess/os.system with unsanitized input
- **Basic injection patterns**: SQL string concatenation, unsanitized shell command construction

**How to scan**: Use Grep with targeted patterns across the codebase. Focus on source files, not vendored dependencies, build artifacts, or lock files. Exclude `.git/`, `node_modules/`, `vendor/`, `__pycache__/`, and similar directories.

**Severity assignment**:

- Hardcoded secrets: warning (SF2, confidence 75-90)
- Dangerous function calls: warning (SF2) or critical (SF1) depending on user input flow
- Injection patterns: warning (SF2, confidence 60-80)

**Scope limitation notice**: every security hygiene finding MUST include a footer recommending dedicated security tools for comprehensive analysis.

---

## Step 4: Distill

After all agents complete:

1. **Filter**: discard findings below 50 confidence. Mark 50-69 as "info" (SF3) regardless of apparent severity.
2. **Deduplicate**: merge by preference: (1) fullest context, (2) most evidence-rich dimension, (3) most recent. Preserve complementary evidence from discarded findings.
3. **Cross-reference** against DECISIONS.md and TODO.md:
   - Matches known decision → discard or downgrade to info (SF3)
   - Matches known issue → "already tracked", skip
   - Genuinely new → include at full severity
4. **Grade** each dimension:
   - **A**: No critical/warning findings. **B**: No critical, some warnings.
   - **C**: 1-2 critical or many warnings. **D**: Multiple critical.
   - **F**: Pervasive critical findings.
5. **Trajectory**: compare to prior HEALTH.md: improved (VT12), degraded (VT13), stable dimensions. Calculate overall trajectory.

---

## Step 5: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns table). See `scripts/self_audit.py` (at v1 skill location `skills/inspektera/scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):
"Tightening this up..." · "Cutting the filler first..." · "One more pass..."

---

## Step 6: Report

Assess each dimension in your response. Write ONLY grade, trajectory marker, and finding summary per dimension to HEALTH.md. No reasoning in the artifact; the conversation preserves analysis, the artifact preserves conclusions.

Output constraint per contract token budgets. Letter grade + ≤3 sentences justification per dimension.

When updating existing HEALTH.md entries (e.g., updating Patterns Observed), use the Edit tool on the specific section rather than rewriting the file. Append new audit entries.

Write the audit results to `HEALTH.md` (append new audit, keep prior audits for trajectory history) and present to the user.

After writing a new audit entry to HEALTH.md, compact older audits via the script. Run: `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py health <path-to-HEALTH.md>`.

Artifact writing follows contract Artifact Writing Conventions: banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

### Report structure

```markdown
## Audit N · YYYY-MM-DD

**Dimensions assessed**: [list]
**Findings**: X critical, Y warnings, Z info (N filtered by confidence)
**Overall trajectory**: ⮉ improving | stable | ⮋ degrading vs Audit N-1
**Grades**: Architecture [B] | Patterns [A] | Coupling [C] | Complexity [B] | Tests [D] | Deps [A] | Security [A]

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
- **Improved**: [what got better and why]
- **Degraded**: [what got worse and why]
- **New findings**: [issues not present in prior audit]
- **Resolved**: [prior findings no longer present]

### Patterns Observed
[De facto architecture patterns extracted, the "what IS" independent of what's stated.]
- Module structure: [how code is organized]
- Error handling: [predominant pattern]
- Testing approach: [how tests are structured]
- Dependency patterns: [how deps are managed]
```

---

## Step 7: Connect

Feed actionable findings into the suite:

1. **TODO.md**: for each critical finding not already tracked, offer to add under the appropriate severity section.
   Severity mapping (protocol: SM1-SM3): critical (SF1) → `## ⇶ Critical` (SI1), warning (SF2) → `## ⇉ Degraded` (SI2), info (SF3) → `## ⇢ Annoying` (SI4). Each entry is a checkbox line: `- [ ] [finding description]`. Get user confirmation before writing.
   Output constraint per contract token budgets.
2. **VISION.md**: if architecture has intentionally evolved past stated architecture, suggest updating via `/resonera`.
3. **Present findings** and ask if the user wants to: file to TODO.md, deliberate via `/resonera`, deep-dive on a dimension, or investigate a specific finding.

---

## Safety rails

<critical>

- NEVER modify code. Inspektera audits; other capabilities fix.
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

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: `─── ⛶ inspektera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete** (EX1): All selected audit dimensions were assessed, findings were synthesized, grades were assigned, HEALTH.md was updated, and the user was presented with actionable results.
- **flagged** (EX2): The audit completed but with notable caveats: one or more dimensions had to be skipped due to missing tooling, confidence was too low to grade a dimension reliably, or critical findings were discovered that require urgent attention beyond the audit scope.
- **stuck** (EX3): Cannot complete the audit because the project is inaccessible, required language tooling is unavailable and manual analysis is not feasible, or filing findings to TODO.md was declined by the user and the results cannot be safely surfaced any other way.
- **waiting** (EX4): The audit target is ambiguous: no project was identified, the codebase is too incomplete to assess meaningfully, or the user's request specifies dimensions that cannot be evaluated without additional information.

---

## Cross-capability integration

Inspektera is part of a twelve-capability suite. It is the feedback loop, the capability that tells realisera whether its work is making things better.

### Inspektera feeds /realisera

Critical and warning findings filed to TODO.md become candidates for realisera's work selection. The severity mapping ensures structural problems compete fairly with feature work. The "Patterns Observed" section helps realisera understand the codebase's de facto architecture when planning changes.

### Inspektera feeds /resonera

When the audit reveals architectural drift, suggest `/resonera` before fixes begin.

Use it when code has moved past stated architecture or competing patterns need a decision.

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
