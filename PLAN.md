# Plan: Rename ecosystem from agent-skills to agentera

<!-- Level: full | Created: 2026-03-31 | Status: active -->
<!-- Decision: DECISIONS.md Decision 9 (firm) -->
<!-- Reviewed: 2026-03-31 | Critic issues: 10 found, 8 addressed, 2 dismissed -->

## What

Rename the skill ecosystem from "agent-skills" to "agentera" across the repository,
GitHub, local filesystem, and Claude Code configuration. Migrate Claude session
artifacts (project memory) to the new path.

### In-scope references

**Repository (10 files, ~17 references):**
- README.md — heading, clone URL
- VISION.md — heading, body text, "Agent Skills format" (line 72)
- DECISIONS.md — historical references throughout (preserved as-is)
- CLAUDE.md — description line ("A Claude Code skill marketplace")
- .claude-plugin/marketplace.json — name field, description field
- references/ecosystem-spec.md — comment header
- scripts/validate-ecosystem.py — docstring
- 4 SKILL.md files (profilera, realisera, inspektera, optimera) — installation path references

**External:**
- GitHub repository name and URL
- Local directory path (~/git/agent-skills → ~/git/agentera)
- Git remote URL
- ~/.claude/settings.json — marketplace name, repo URL, 4 skill enables
- ~/.claude/plugins/marketplaces/agent-skills/ — cached marketplace clone
- ~/.claude/projects/-home-jgabor-git-agent-skills/memory/ — 5 memory files

## Why

Decision 9 established "agentera" as the ecosystem name. The current name "agent-skills"
is generic and doesn't represent the ecosystem's identity. The rename must propagate
everywhere the old name appears to avoid broken references and confusion.

## Constraints

- All "agent-skills" references in DECISIONS.md are historical deliberation context and
  must NOT be updated — they document what was decided and when, using the name that was
  current at the time
- Skills installed via symlinks (~/.claude/skills/) point to ~/.agents/skills/ and do NOT
  reference "agent-skills" — no change needed there
- The ecosystem linter must pass after all changes
- Claude Code must load all skills correctly after configuration changes
- Memory files must survive the migration — no data loss
- Task 3 (directory rename) invalidates the current working directory — this is a session
  boundary that requires manual execution or a session restart

## Scope

**In**: All references to "agent-skills" in the repo (except DECISIONS.md history), GitHub
repo name, local directory, Claude config, marketplace description, CLAUDE.md description,
and project memory migration.

**Out**: Skill names (they keep their Swedish -era names). SKILL.md content beyond the
path references. Other Claude projects/sessions unrelated to this repo. Orphaned
marketplace cache project directory (harmless session data only).

**Deferred**: Updating any external documentation, blog posts, or references outside this
repo and Claude config.

## Design

The rename flows top-down: repo content first, then commit, then GitHub, then local
filesystem, then Claude config. Each layer depends on the previous being stable.

GitHub rename must happen BEFORE local directory rename (GitHub sets up redirects from
the old URL). Local directory rename must happen BEFORE Claude config updates (new path
must exist for memory migration). The marketplace cache should be deleted and re-pulled
rather than patched in place.

Task 3 is a **session boundary**: renaming the local directory invalidates the current
Claude Code session's working directory. The user must either execute this step manually
or restart Claude Code afterward.

## Tasks

### Task 1: Update all in-repo references
**Depends on**: none
**Status**: complete
**Acceptance**:
- GIVEN any file in the repository WHEN searched for "agent-skills" THEN only references in DECISIONS.md are found (all DECISIONS.md references are historical and preserved)
- GIVEN README.md WHEN read THEN the heading says "agentera" and the clone URL references "agentera"
- GIVEN VISION.md WHEN read THEN the heading says "agentera", the body text says "agentera", and the conceptual format name is updated
- GIVEN the marketplace manifest WHEN read THEN both the name field and description reflect "agentera"
- GIVEN CLAUDE.md WHEN read THEN it identifies the ecosystem as "agentera"

### Task 2: Commit and push the rename
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN the git log WHEN checked THEN a commit exists containing the rename changes
- GIVEN the remote WHEN checked THEN the commit has been pushed

### Task 3: Rename GitHub repository and local directory ⚠️ SESSION BOUNDARY
**Depends on**: Task 2
**Status**: pending
**Acceptance**:
- GIVEN the GitHub API WHEN the repo is queried THEN it exists at jgabor/agentera
- GIVEN the local filesystem WHEN checked THEN the repo lives at ~/git/agentera
- GIVEN git remote -v WHEN run from ~/git/agentera THEN the URL points to jgabor/agentera.git
**Note**: This task invalidates the current working directory. Execute the GitHub rename
first, then the local directory rename, then update the git remote. Restart Claude Code
in ~/git/agentera before proceeding to Task 4.

### Task 4: Update Claude Code configuration and migrate project memory
**Depends on**: Task 3
**Status**: pending
**Acceptance**:
- GIVEN ~/.claude/settings.json WHEN read THEN the marketplace is named "agentera" and points to jgabor/agentera
- GIVEN the skill enables in settings.json WHEN read THEN they reference @agentera not @agent-skills
- GIVEN the old marketplace cache WHEN checked THEN it has been removed
- GIVEN the Claude project directory for ~/git/agentera WHEN checked THEN all 5 memory files from the old project path are present at the new path-derived key

### Task 5: Verify end-to-end
**Depends on**: Task 4
**Status**: pending
**Acceptance**:
- GIVEN the ecosystem linter WHEN run from ~/git/agentera THEN it passes with no errors
- GIVEN a search across the repo and Claude config WHEN run for "agent-skills" THEN no stale references remain except DECISIONS.md historical entries
- GIVEN a fresh Claude Code session WHEN started in ~/git/agentera THEN skills from the agentera marketplace load (manual verification — requires session restart)

## Overall Acceptance

- GIVEN the ecosystem WHEN accessed by any path (GitHub URL, local directory, Claude settings, skill references, marketplace manifest) THEN it is consistently identified as "agentera"
- GIVEN the ecosystem linter and skill loading WHEN tested THEN everything works as before the rename
- GIVEN the Claude project memory WHEN accessed THEN all prior session learnings are preserved

## Surprises
