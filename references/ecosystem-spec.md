# Ecosystem Spec

<!-- Shared primitives for the agentera ecosystem. -->
<!-- All 10 skills/*/SKILL.md files must align with this spec. -->
<!-- Validated by scripts/validate-ecosystem.py (pre-commit hook). -->
<!-- See Decisions 7 and 8 in DECISIONS.md for rationale. -->

## 1. Confidence Scale

Canonical scale: **0-100 integer**.

Five tiers with shared boundaries. Each skill defines its own domain-specific labels
describing what the tier means in its context.

| Tier | Range | Semantic |
|------|-------|----------|
| 1 (highest) | 90-100 | Verified / near-certain |
| 2 | 70-89 | Strong evidence / established |
| 3 | 50-69 | Moderate evidence / emerging |
| 4 | 30-49 | Weak evidence / uncertain |
| 5 (lowest) | 0-29 | Speculative / extrapolated |

**Rules**:
- Skills producing confidence scores MUST use integer 0-100
- Skills consuming confidence scores MUST interpret them against these tier boundaries
- Temporal decay is opt-in: skills with a temporal dimension (e.g., profilera) may apply
  exponential decay; skills without one (e.g., inspektera) use static scores
- When referencing profile consumption thresholds, use 65+ for "strong constraint" and
  <45 for "suggestion" (integer equivalents of the 0.0-1.0 thresholds)

**Linter check**: Deterministic — regex for tier boundaries in SKILL.md text.

## 2. Severity Levels

Two severity vocabularies serve different purposes in the ecosystem.

### Finding severity (audit output)

Used by skills that produce audit findings (inspektera, dokumentera, visualisera).

| Level | Meaning |
|-------|---------|
| **critical** | Broken functionality, security issue, data loss risk |
| **warning** | Works but poorly — fragile, confusing, or degraded |
| **info** | Minor — cosmetic, style, low-impact improvement |

### Issue severity (ISSUES.md)

Used by all skills that file to ISSUES.md.

| Level | Meaning |
|-------|---------|
| **critical** | Broken functionality, blocks progress |
| **degraded** | Works but poorly — slow, fragile, ugly |
| **annoying** | Cosmetic, minor friction, style nit |

### Mapping

When filing audit findings to ISSUES.md, map as follows:

| Finding severity | → | Issue severity |
|-----------------|---|----------------|
| critical | → | critical |
| warning | → | degraded |
| info | → | annoying |

**Linter check**: Deterministic — exact string matching for severity terms in context.

## 3. Decision Confidence Labels

Used in DECISIONS.md entries (produced by resonera, consumed by realisera, planera,
inspektera, profilera).

| Label | Meaning | How consuming skills treat it |
|-------|---------|-------------------------------|
| **firm** | User is committed | Treat as a hard constraint |
| **provisional** | Best current answer, open to revision | Treat as a strong default |
| **exploratory** | Direction to try, expected to be revisited | Treat as a suggestion |

**Linter check**: Deterministic — enum values in DECISIONS.md format definition.

## 4. Artifact Format Contracts

Each skill-maintained artifact has an expected structure. Producing skills define the
format; consuming skills depend on it.

| Artifact | Producer | Consumers | Key structural elements |
|----------|----------|-----------|------------------------|
| VISION.md | visionera, realisera | realisera, planera, inspektera, dokumentera, visualisera | ## North Star, ## Who It's For, ## Principles, ## Direction, ## Identity |
| DECISIONS.md | resonera | planera, realisera, inspektera, profilera, optimera | ## Decision N — date, **Question/Context/Alternatives/Choice/Reasoning/Confidence/Feeds into** |
| PLAN.md | planera | realisera, inspektera | <!-- Level/Created/Status -->, ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| PROGRESS.md | realisera | planera, inspektera, dokumentera, visionera | ## Cycle N — date, **What/Commit/Inspiration/Discovered/Next** |
| ISSUES.md | realisera, inspektera | realisera, planera | ## Open/Resolved, ### [severity] description |
| HEALTH.md | inspektera | realisera, planera | ## Audit N — date, **Dimensions/Findings/Overall/Grades**, per-dimension sections |
| OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints |
| EXPERIMENTS.md | optimera | optimera | ## Experiment N — date, **Hypothesis/Method/Result/Conclusion** |
| DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| PROFILE.md | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Linter check**: Advisory — flags missing structural elements as warnings, not errors.

## 5. Artifact Path Resolution

Every skill that reads or writes artifacts MUST include the artifact path resolution
instruction. The canonical template:

```
### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename ({OWN_ARTIFACTS},
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill
{reads_or_writes} ({CROSS_ARTIFACTS}).
```

Where:
- `{OWN_ARTIFACTS}` = the skill's own artifact filenames
- `{reads_or_writes}` = "reads", "writes", or "reads and writes" as appropriate
- `{CROSS_ARTIFACTS}` = artifacts from other skills that this skill accesses

The section MUST appear under "## State artifacts" (not under cross-skill integration or
elsewhere).

**Linter check**: Deterministic — section presence under correct parent heading, core
sentence pattern matching.

## 6. Profile Consumption

Skills that read the decision profile use one of two patterns:

### Script pattern (for skills that need confidence-weighted summaries)

```
python3 -m scripts.effective_profile
```

Run from the profilera skill directory. Mentioned skills: realisera, optimera, inspektera,
planera, inspirera.

Standard threshold language (after migration to 0-100):
- "high effective confidence entries (65+) are strong constraints"
- "low effective confidence entries (<45) are suggestions"

### Direct read pattern (for skills that need qualitative profile context)

Read `~/.claude/profile/PROFILE.md` directly. Mentioned skills: resonera, visionera,
dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic — script invocation syntax, threshold values, fallback
instruction presence.

## 7. Cross-Skill Integration Section

Every SKILL.md MUST contain a `## Cross-skill integration` section. Requirements:

### Ecosystem language

The section MUST open with: "[Skill name] is part of a ten-skill ecosystem."

### Required references

The skill dependency graph defines which skills must be referenced:

| Skill | Must reference |
|-------|---------------|
| inspirera | realisera, optimera, visionera, resonera, profilera |
| profilera | realisera, optimera, inspirera, resonera, inspektera |
| realisera | visionera, optimera, inspirera, resonera, planera, inspektera, profilera |
| optimera | realisera, resonera, inspektera, profilera |
| resonera | realisera, optimera, inspirera, profilera, planera, inspektera |
| inspektera | realisera, resonera, planera, optimera, profilera |
| planera | resonera, realisera, optimera, inspektera, profilera, inspirera, dokumentera |
| visionera | realisera, resonera, profilera, inspirera, inspektera, visualisera |
| dokumentera | planera, realisera, inspektera, visionera, profilera |
| visualisera | visionera, realisera, dokumentera, inspektera, profilera, inspirera, resonera |

**Linter check**: Deterministic — section heading presence, ecosystem language match,
required skill references present.

## 8. Safety Rails Section

Every SKILL.md MUST contain a `## Safety rails` section with:

1. Opening `<critical>` tag
2. Bullet list of constraints (minimum 3)
3. Closing `</critical>` tag

Each constraint MUST begin with "NEVER" to clearly signal what the skill must not do.

**Linter check**: Deterministic — section heading, `<critical>` tag presence, minimum
constraint count, "NEVER" prefix pattern.

## 9. SKILL.md Frontmatter

Every SKILL.md MUST begin with YAML frontmatter containing:

| Field | Required | Format |
|-------|----------|--------|
| `name` | Yes | kebab-case skill name |
| `description` | Yes | Multi-line string (use `>` block scalar). Must include the skill's full acronym expansion, trigger patterns, and what the skill produces. |

The description field serves as the skill's trigger specification — it MUST contain
enough trigger phrases for Claude to activate the skill from natural language.

**Linter check**: Deterministic — frontmatter presence, required field presence, name
format (kebab-case).

## 10. Exit Signals

Every skill MUST report a completion status at the end of its workflow. This enables
downstream skills, orchestration layers, and the user to determine what happened without
parsing natural language.

### Statuses

| Status | Meaning | When to use |
|--------|---------|-------------|
| **complete** | All steps completed successfully | The skill's workflow ran to completion and all acceptance criteria (if any) were met |
| **flagged** | Completed, but with issues the user should know about | The workflow completed but discovered problems, made compromises, or has caveats worth surfacing |
| **stuck** | Cannot proceed | A hard blocker prevents completion — missing dependency, permission issue, ambiguous requirement too consequential to resolve autonomously |
| **waiting** | Missing information required to continue | The skill needs input, clarification, or a decision from the user or another skill before it can proceed |

### Rules

- Skills MUST report exactly one status at workflow completion
- The status MUST appear in a `## Exit signals` section in each SKILL.md,
  defining when the skill reports each status with skill-specific guidance
- `flagged` MUST list each concern — a bare status without details is
  not acceptable
- `stuck` and `waiting` MUST state what is blocking / what is needed and
  what was attempted
- The `## Exit signals` section is a peer to `## Safety rails` (not nested
  inside it)

### SKILL.md structural requirement

Each SKILL.md MUST contain a `## Exit signals` section with:

1. All four status terms (complete, flagged, stuck, waiting)
2. Skill-specific guidance on when each status applies in that skill's context

**Linter check**: Deterministic — `## Exit signals` heading presence, all four
status terms present in the section content (`exit-signals`).

## 11. Loop Guard

Skills that run autonomous loops (currently: realisera, optimera) MUST include an
escalation rule to prevent runaway cycles producing bad work.

### The rule

When the skill detects 3 consecutive failed cycles, it MUST:

1. **Stop** — do not attempt a 4th cycle on the same problem
2. **Log** — file the failure pattern to ISSUES.md with context: what was attempted,
   what failed, and what the skill thinks is wrong
3. **Surface** — tell the user what happened and recommend a course of action
   (e.g., "/resonera to deliberate on the approach", "manual investigation needed",
   "dependency missing")

### Failure detection

Consecutive failures are detected by reading the last 3 entries in PROGRESS.md. A cycle
counts as failed when:

- The commit was reverted or the verification step failed
- The cycle logged a blocker and pivoted to different work 3 times in a row
  (3 consecutive pivots = the available work surface is exhausted)
- The cycle's "Discovered" field logs the same issue that was supposed to be fixed

### Complementary mechanisms

Optimera's existing plateau detection in `analyze_experiments.py` detects experiment
stagnation (no improvement over N iterations). The loop guard is complementary:
plateau detection handles metric stagnation, escalation handles general execution failure.
Both can trigger independently.

### Applicability

The escalation rule is REQUIRED for autonomous-loop skills: `realisera`, `optimera`.

Other skills MAY include loop guard language but are not required to — their workflows
are typically single-invocation and do not risk runaway cycles.

### SKILL.md structural requirement

Autonomous-loop skills MUST include loop guard language in their
`## Exit signals` section, referencing the 3-failure threshold and
PROGRESS.md inspection.

**Linter check**: Deterministic — for skills in the autonomous-loop set (realisera,
optimera), check that the `## Exit signals` section contains both "3" (the
threshold) and a reference to PROGRESS.md or consecutive failure detection (`loop-guard`). Advisory
for all other skills.
