---
name: inspirera
description: >
  INSPIRERA (Insight Navigation: Source Pattern Identification and Resonance, Evaluate, Reframe, Assimilate). Analyzes an external link (GitHub repo, article, blog post, docs page, HN thread) and maps its concepts, patterns, and primitives to one of the user's own projects. Use this skill whenever the user drops a URL alongside a project name or repo link, or asks something like "could I use this in X?", "how does this apply to my project?", "is this relevant to Y?", "what can I take from this?", "what do you think of this library?", "should I adopt X?", "review this repo for ideas", "anything worth stealing from X?", or "how does X compare to what I'm doing?". Also trigger when the user pastes a link and mentions one of their own repos or codebases in the same message, even without explicit framing, or when they paste a link while working in a local project directory and the context implies they want to apply the ideas. Produces a structured markdown analysis with applicability matrix and recommended next steps.
spec_sections: [2, 4, 5, 6, 12]
---

# INSPIRERA

**Insight Navigation: Source Pattern Identification and Resonance. Evaluate, Reframe, Assimilate**

Analyze an external resource and map its ideas to a target project. Output a structured markdown analysis the user can navigate and act on.

Skill introduction: `─── ⬚ inspirera · analysis ───`

Step markers: display `── step N/5: verb` before each step.
Steps: identify, read, explore, map, deliver.

---

## Step 1: Identify source and target

From the user's message, extract:

- **Source**: the external URL (GitHub repo, article, docs, HN thread, etc.)
- **Target**: the user's project, which could be any of:
  - A **GitHub repo URL** → explore via GitHub MCP
  - A **local path** or project name → explore via filesystem tools
  - The **current working directory** → if the user says "my project" / "what I'm building" without a URL, and they're clearly working in a project, treat cwd as the target
  - **Absent** → if truly no target is implied, skip Steps 3–4 and do source-only analysis

---

## Step 2: Read the source

This should feel like a colleague diving into something interesting, genuinely curious, reading deeply, forming opinions as you go. Not a report generator collecting data points.

### GitHub repos

Use GitHub MCP to explore deeply:

1. List root directory structure
2. Read README
3. Read key source directories until you understand: core abstractions, design patterns,
   notable primitives, dependencies, clever approaches worth borrowing

Go deep and don't stop at the README. If GitHub MCP returns errors, fall back to public pages or note the limitation.

### Articles, blog posts, docs pages

Fetch full content. Extract core thesis, named concepts/patterns, code samples, and referenced tools. If paywalled, try reader-mode variant; if that fails, note the limitation.

### Hacker News threads

Read both the linked article and top comments. HN comments often contain the most useful distillation. Treat as signal.

### Known libraries

For well-known libraries, also check context7 for up-to-date docs beyond the README.

Before proceeding to target analysis: in your response, list the 3-5 most transferable concepts from the source. These survive if the source file reads are cleared.

---

## Step 3: Read the target project

Choose the exploration strategy based on the target type identified in Step 1.

### Local projects (current directory or local path)

Common case. Use filesystem tools (faster, includes uncommitted work):

1. `Glob` to map the directory structure (e.g. `**/*.{ts,go,py,rs}`)
2. Read the README if one exists
3. Check dependency manifests (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, etc.)
4. `Grep` for patterns, imports, or abstractions relevant to the source's concepts
5. Read key source files to understand architecture and current patterns

### Remote GitHub repos

Use the GitHub MCP:

1. List the root directory structure
2. Read the README
3. Read dependency manifests and key source files

### Build understanding of

Language, stack, dependencies, architecture, patterns, and problems being solved.

### Check for existing usage

Does the target already use the source (or a fork/alternative)?
- **Already using**: "Getting the most out of it?" Focus on underused features and better patterns.
- **Using alternative**: "Worth switching?" Compare approaches and migration cost.
- **Not using**: "Should you adopt?" This is the default framing.

---

## Step 4: Map concepts across

With both codebases understood, reason about applicability:

- What is the source doing that the target should be?
- Abstractions that simplify current complexity?
- Patterns the target implements manually or poorly?
- Primitives worth borrowing or adapting?
- Source doing something the target does, but better?
- Fundamentally incompatible? Say so clearly.
- Adoption cost: one-file change or multi-sprint refactor?

---

## Step 5: Deliver the analysis

The sharp colleague, here to share what you dug up, not file a report. Open with your take before the structured sections: what excited you, what surprised you, what the user should care about most. "Here's what I found and what matters for us." The structured analysis follows, but the human read comes first.

Write a **structured markdown analysis**:

### Output format

````markdown
# [Source Name] → [Target Name]: Cross-Pollination Analysis

## TL;DR
One or two sentences. Is this worth pursuing? What's the strongest single takeaway?

## Source Overview
Brief summary of what the source does and its core design philosophy.

## Key Concepts

### [Concept Name]
What it is, why it's interesting, and concretely where/how it applies to the target.

### [Concept Name]
...repeat for each significant concept (typically 2–5)

Reason through concept applicability in your response text. The Applicability Matrix below
should contain only conclusions, not reasoning chains.
Output constraint: ≤15 words per matrix cell.

## Applicability Matrix

| Concept | Relevance | Effort | Where in [Target] | Already Partially Done? |
|---------|-----------|--------|-------------------|------------------------|
| ...     | High/Med/Low | Low/Med/High | specific module or file | Yes/No |

## What Doesn't Apply
Honest assessment of concepts/patterns that look interesting but don't fit, and why.
Being clear about what *not* to adopt is as valuable as the recommendations.

## Recommended Next Steps
▸ [action] · [specific file or module]
▸ [action] · [specific file or module]
Ordered by value/effort ratio.
````

**Tone**: direct, technically fluent. Skip empty sections. Lead with highest signal.

Offer to go deeper: prototype a change, explore a concept with code, compare alternatives.

### No target given

Surface transferable concepts in general terms. Skip Applicability Matrix. Ask if the user wants to map to a specific project.

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ⬚ inspirera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: Source was read deeply, target project was explored (if provided), concept mapping was completed, and a structured analysis with applicability matrix and recommended next steps was delivered.
- **flagged**: Analysis completed but with limitations worth surfacing: the source was paywalled or truncated, the target project was inaccessible, or key concepts could not be fully assessed for fit (e.g., incompatible language or paradigm).
- **stuck**: Cannot proceed because the source URL is inaccessible and no fallback content is available, or the target project specified does not exist and cannot be located.
- **waiting**: The source link was not provided or is malformed, or the target project is genuinely ambiguous and neither the current directory nor context resolves it.

---

## State artifacts

No dedicated state file. Writes to other skills' artifacts.

| Artifact | Purpose | Access |
|----------|---------|--------|
| TODO.md | File actionable findings for realisera (severity per ecosystem context) | write |
| VISION.md | Refine direction when inspiration shifts thinking | write |

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (TODO.md, VISION.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact references in this skill, including cross-skill writes (TODO.md, VISION.md).

### Ecosystem context

Before starting, read `references/ecosystem-context.md` (relative to this skill's directory) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the ecosystem context takes precedence.

---

## Cross-skill integration

Inspirera is part of a twelve-skill ecosystem. Its analysis feeds naturally into the other skills.

### Feeding into /realisera
Add actionable findings to the project's TODO.md, classifying each by severity per ecosystem context severity levels. Or refine VISION.md's direction if the inspiration shifts thinking. The next realisera cycle picks up the changes automatically.

### Feeding into /optimera
When the source contains optimization techniques (performance patterns, algorithm improvements, caching strategies), optimera's Hypothesize step can draw on the analysis for its next experiment.

### Informed by /profilera
If a decision profile exists at `~/.claude/profile/PROFILE.md`, run the effective profile script (`python3 scripts/effective_profile.py` from the profilera skill directory) for a confidence-weighted summary. Use effective confidence to weight applicability judgments per ecosystem context profile consumption conventions.
If the script or PROFILE.md is missing, proceed without persona grounding.

### Feeding into /visionera
When the analysis shifts thinking about the project's direction (a new paradigm, a competitor's approach, or a user need not yet captured), the findings can inform vision refinement. Suggest `/visionera` to revisit VISION.md with the new context.

### Feeding into /planera
When the analysis recommends adopting patterns or libraries, planera can incorporate those recommendations into a plan's design section and task decomposition.

### Feeding into /resonera
When the analysis surfaces recommendations that require deliberation (competing approaches, unclear adoption cost, or tradeoffs the user needs to resolve), suggest `/resonera` to think it through before acting. Resonera can evaluate which recommendations are actually worth adopting and capture the reasoning in DECISIONS.md.

---

## Safety rails

<critical>

- NEVER modify code in the target project. Inspirera analyzes; other skills implement.
- NEVER write to TODO.md or VISION.md without explicit user confirmation. Present findings
  and get approval before filing.
- NEVER present shallow analysis as deep insight. If you haven't read the source thoroughly,
  say so.
- NEVER recommend adoption without assessing fit. Every recommendation must consider the
  target project's constraints, stack, and principles.
- NEVER fabricate source content. Quote actual code and text from the source.

</critical>

---

## Getting started

### Analyze a GitHub repo
```
/inspirera https://github.com/org/repo
```
Reads the repo, maps its patterns to your current project.

### Analyze an article or docs page
```
/inspirera https://example.com/blog/interesting-approach
```
Extracts transferable concepts and assesses applicability.

### Feed findings into the development loop
After analysis, file actionable findings to TODO.md for `/realisera` to pick up, or refine VISION.md if the research shifts your project's direction.

---

## Notes on depth vs. speed

- Read more files, not fewer. Shallow reads produce shallow analysis
- Large repos: focus on modules most relevant to the concept, not everything
- Explore source and target concurrently where possible
- Always use GitHub MCP for GitHub URLs
