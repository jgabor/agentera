---
name: inspirera
description: >
  INSPIRERA — Insight Navigation: Source Pattern Identification and Resonance — Evaluate,
  Reframe, Assimilate. Analyzes an external link (GitHub repo, article, blog post, docs page, HN thread) and maps its
  concepts, patterns, and primitives to one of the user's own projects. Use this skill whenever
  the user drops a URL alongside a project name or repo link, or asks something like "could I use
  this in X?", "how does this apply to my project?", "is this relevant to Y?", "what can I take
  from this?", "what do you think of this library?", "should I adopt X?", "review this repo for
  ideas", "anything worth stealing from X?", or "how does X compare to what I'm doing?". Also
  trigger when the user pastes a link and mentions one of their own repos or codebases in the same
  message, even without explicit framing — or when they paste a link while working in a local
  project directory and the context implies they want to apply the ideas. Produces a structured
  markdown analysis with applicability matrix and recommended next steps.
---

# INSPIRERA

**Insight Navigation: Source Pattern Identification and Resonance — Evaluate, Reframe, Assimilate**

Analyze an external resource and map its ideas to a target project the user names (or the project
they're currently working in). Output a structured markdown analysis the user can navigate and
act on.

---

## Step 1: Identify source and target

From the user's message, extract:

- **Source**: the external URL (GitHub repo, article, docs, HN thread, etc.)
- **Target**: the user's project — could be any of:
  - A **GitHub repo URL** → explore via GitHub MCP
  - A **local path** or project name → explore via filesystem tools
  - The **current working directory** → if the user says "my project" / "what I'm building" without a URL, and they're clearly working in a project, treat cwd as the target
  - **Absent** → if truly no target is implied, skip Steps 3–4 and do source-only analysis

---

## Step 2: Read the source

### GitHub repos

Use the GitHub MCP to explore the repo deeply enough to understand its design:

1. `get_file_contents` on the root to list directory structure
2. Read `README.md` (or `README`, `readme.md`)
3. Identify key source directories (e.g. `cmd/`, `internal/`, `src/`, `lib/`, `pkg/`) — read
   the files within them until you have a solid mental model of:
   - Core abstractions / types / interfaces
   - Design patterns used
   - Notable primitives or algorithms
   - Dependencies and what they reveal about the architecture
   - Any non-obvious or clever approaches worth borrowing

Don't stop at the README — go deep. If a file looks interesting, read it.

If the GitHub MCP returns access errors (private repo, rate limit), fall back to fetching the
repo's public pages or note what you couldn't access.

### Articles, blog posts, docs pages

Fetch the full page content. Extract:

- Core thesis / argument
- Named concepts, patterns, techniques, or primitives introduced
- Any code samples and what they demonstrate
- Referenced tools, libraries, or further reading

If content is paywalled or truncated, try fetching a reader-mode or print URL variant. If that
also fails, work with what you have and note the limitation.

### Hacker News threads

Fetch the thread URL. Read both the linked article (if any) and the top comments. HN threads
often contain the most useful distillation of a concept — treat comments as signal.

### Known libraries

If the source is a well-known library or framework, also check context7 for up-to-date
documentation — this can surface API details and usage patterns that the README alone won't cover.

---

## Step 3: Read the target project

Choose the exploration strategy based on the target type identified in Step 1.

### Local projects (current directory or local path)

This is the common case — the user is working in their project and wants to know how an external
resource applies. Use filesystem tools directly since they're faster and include uncommitted work:

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

### In either case, build understanding of:

- Language, stack, and dependencies
- Current architecture and major modules
- Existing patterns and abstractions
- What problems the project is solving

### Check for existing usage

Look at the target's dependencies — does it already use the source library (or a fork or
alternative)? This shifts the analysis fundamentally:

- **Already using it**: Focus on "are you getting the most out of it?" — underused features,
  better patterns, version-gated improvements
- **Using an alternative**: Focus on "is switching worth it?" — compare approaches, migration cost
- **Not using it**: Focus on "should you adopt it?" — the default framing

---

## Step 4: Map concepts across

With both codebases understood, reason about applicability:

### Framing questions

- What is the source doing that the target isn't, but probably should be?
- Are there abstractions in the source that would simplify something currently complex in the target?
- Does the source introduce a pattern the target is implementing manually or poorly?
- Are there primitives (data structures, interfaces, middleware patterns, error handling idioms)
  worth borrowing verbatim or adapting?
- Is the source doing something the target already does — and doing it better?
- Is the source's approach fundamentally incompatible with the target (wrong language, wrong
  paradigm, overkill for the scale)? Say so clearly.
- What would the adoption cost actually look like — a one-file change or a multi-sprint refactor?

---

## Step 5: Deliver the analysis

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

## Applicability Matrix

| Concept | Relevance | Effort | Where in [Target] | Already Partially Done? |
|---------|-----------|--------|-------------------|------------------------|
| ...     | High/Med/Low | Low/Med/High | specific module or file | Yes/No |

## What Doesn't Apply
Honest assessment of concepts/patterns that look interesting but don't fit — and why.
Being clear about what *not* to adopt is as valuable as the recommendations.

## Recommended Next Steps
Short numbered list of concrete actions, ordered by value/effort ratio.
Where possible, name the specific files or modules that would change.
````

**Tone**: Direct and technically fluent. Skip any section that has nothing useful to say. Lead
with the highest-signal concepts. Be honest when something doesn't apply.

After presenting the analysis, offer to go deeper — for example:
- Prototype a specific recommended change as a code diff
- Explore a concept in more detail with code examples
- Compare alternatives to the source library

### If no target was given

Surface the most interesting or transferable concepts from the source in general terms. Skip the
Applicability Matrix and "Where in Target" columns. Ask the user if they want to map it to a
specific project.

---

## Cross-skill integration

Inspirera is part of a four-skill ecosystem. Its analysis feeds naturally into the other skills.

### Feeding into /realisera
Add actionable findings to the project's ISSUES.md, or refine VISION.md's direction if the
inspiration shifts thinking. The next realisera cycle picks up the changes automatically.

### Feeding into /optimera
When the source contains optimization techniques (performance patterns, algorithm improvements,
caching strategies), optimera's Hypothesize step can draw on the analysis for its next experiment.

### Informed by /profilera
If a decision profile exists at `~/.claude/profile/PROFILE.md`, run the effective profile
script (`python3 -m scripts.effective_profile` from the profilera skill directory) for a
confidence-weighted summary. Use effective confidence to weight applicability judgments —
high-confidence entries strongly constrain recommendations, low-confidence entries are
treated as tendencies rather than rules.

---

## Notes on depth vs. speed

- Prefer reading more files over fewer — shallow reads produce shallow analysis
- If a repo is very large (monorepo, etc.), focus on the modules most relevant to the concept
  being evaluated; don't try to read everything
- When both source and target need exploration, start both concurrently where possible
- Always use the GitHub MCP for GitHub URLs — don't try to web-fetch raw GitHub pages
