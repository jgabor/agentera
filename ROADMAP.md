# Agentera 2.0 Roadmap

Decision 39. Big bang cutover from feat/v2 branch/worktree.

## Principles

- Feedback loop is the product. Everything serves compound value across sessions.
- Spec dissolves into schemas. No central SPEC.md. Per-capability schemas + thin shared protocol.
- Agent-facing artifacts are structured data, not prose. A query CLI is the seam.
- One install, one entry point, one query interface.

## Target Architecture

### Distribution

Single bundled skill (`/agentera`) containing 12 capabilities.

```
skills/agentera/
  SKILL.md                    # Master entry: routing + shared protocol
  protocol.yaml               # Shared primitives (confidence, severity, visual tokens)
  capabilities/
    hej/
      prose.md                # Behavioral instructions (agent reads this)
      schemas/
        artifacts.yaml        # Artifact shapes hej produces/consumes
        workflow.yaml         # Steps, triggers, exit conditions
        validation.yaml       # Validation rules
    resonera/
      prose.md
      schemas/
        ...
    ... (12 capabilities total)
```

### Artifacts

**Human-facing (project root):**

- TODO.md -- open issues, severity-ranked
- CHANGELOG.md -- release history
- DESIGN.md -- visual identity system

**Agent-facing (`.agentera/`, structured data):**

- All other state: VISION, PROGRESS, DECISIONS, HEALTH, SESSION, PLAN, OBJECTIVE, EXPERIMENTS, DOCS
- Format: YAML or JSON (schema-defined per artifact)
- Queried through the universal CLI, not read directly by the agent

### Query CLI

Two surface commands. `agentera query` answers questions about project state. `agentera prime` prints a static guidance blob that teaches the agent when and how to use agentera commands before falling back to native read/grep.

```
agentera prime                                # Print agent-priming guidance
agentera query last-phase                     # What phase was the last cycle?
agentera query decisions --topic runtime      # Decisions about runtime support
agentera query health --dimension coupling    # Latest coupling grade
agentera query open-todos --severity critical # Critical open issues
```

`agentera prime` takes no arguments and produces identical output every invocation. The output is a concise routing guide: which questions go through agentera, which fall back to native tools, and how to recover from stale or missing artifacts. Inspired by the `leda prime` pattern from the leda dependency-graph CLI.

The CLI is the deep module: one interface, all artifact knowledge behind it. Changing artifact format only affects CLI internals.

### Hooks

Hooks validate against capability-local schemas. No central contracts.json. The hook discovers schemas from the capability directory structure and validates writes against the matching schema.

### Master SKILL.md

Starts full: hej-style orientation briefing + routing to capabilities. Optimization target: thin dispatcher that reads trigger patterns from capability schemas and loads only the matching capability's prose.

## Work Breakdown

### Phase 1: Infrastructure (weeks 1-2) ✓

Build the skeleton that everything else plugs into.

- [x] Define capability schema contract (what fields a capability schema must contain)
- [x] Define shared protocol schema (confidence, severity, visual tokens, phase model)
- [x] Build the universal query CLI scaffold (including `agentera prime` command)
- [x] Define agent-facing artifact schemas (one per artifact type)
- [x] Build artifact migration tool (current Markdown -> structured data)
- [x] Rewrite hook to validate against capability-local schemas
- [x] Set up feat/v2 branch and worktree

### Phase 2: Core capabilities (weeks 3-5) ✓

Port the 12 capabilities from prose SKILL.md to prose + schema model.

- [x] hej (routing + orientation) -- becomes the master SKILL.md's core logic
- [x] realisera (autonomous development)
- [x] resonera (deliberation)
- [x] planera (planning)
- [x] inspektera (auditing)
- [x] optimera (metric optimization)
- [x] orkestrera (multi-skill orchestration)
- [x] visionera (vision definition)
- [x] visualisera (design system)
- [x] dokumentera (documentation)
- [x] profilera (decision profiling)
- [x] inspirera (external pattern analysis)

### Phase 3: Integration (weeks 5-6)

Wire everything together and validate.

- [ ] Cross-capability dependency resolution via schemas
- [ ] Hook integration with capability-local schemas
- [ ] Query CLI commands for all artifact types
- [ ] Runtime adapter updates (Claude Code, OpenCode, Codex, Copilot)
- [ ] Port existing 577 tests to the new structure
- [ ] Smoke tests across all 4 runtimes

### Phase 4: Validation & cutover (week 7)

Prove it works, then switch.

- [ ] Full test suite green
- [ ] Semantic eval port to 2.0 fixture format
- [ ] Token consumption benchmark: baseline vs 2.0 (target: 40%+ reduction)
- [ ] Merge feat/v2 to main
- [ ] Version bump to 2.0.0

## Success Metrics

| Metric | Current | Target | How to measure |
|--------|---------|--------|----------------|
| Tokens per session (typical cross-skill workflow) | baseline | -40% | Token probe before/after |
| Places to update for new artifact | 3-5 | 1 | Add a test artifact and count touch points |
| Hook lines of code | 908 | <200 | wc -l |
| Schema files per capability | 0 | 2-3 | ls skills/agentera/capabilities/*/schemas/ |
| Install command complexity | 4 runtime-specific | 1 per runtime | Install from scratch on clean machine |

## Resolved Questions

- **Artifact format**: YAML for all agent-facing artifacts (Decision 40). Token experiment confirmed format choice doesn't affect agent-visible consumption because the query CLI is the seam. YAML wins on human-glanceability and smallest bytes for single entries.
- **Master SKILL.md size**: Deferred to Phase 1. Measure after hej port reveals natural size. Optimization target remains: thin schema-driven dispatcher.
- **Backward compatibility**: No. Migration tool handles one-time v1 Markdown to v2 YAML conversion. Consistent with D39 big bang cutover.
- **Naming**: Sub-modules are "capabilities." Aligns with SKILL.md vocabulary and distinguishes from the v1 "skills" concept.
