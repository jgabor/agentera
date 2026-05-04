---
name: agentera
description: >
  The open protocol for turning AI agents into engineering teams.
  One bundled skill with twelve capabilities, each defined by human-readable
  prose and machine-readable schemas. The agent reads this file to route
  incoming requests to the right capability.
version: "2.0.0"
spec_sections: [1, 2, 3, 4, 5, 6, 11, 13, 18, 19, 20, 22, 23]
---

# agentera

One install, one entry point, one query interface to all project state. Twelve capabilities bundled into a single skill.

---

## Shared Protocol

All capabilities reference shared primitives defined in `protocol.yaml`:

- **Confidence scale**: 0-100, five tiers with explicit boundaries
- **Severity levels**: finding vocabulary and issue vocabulary
- **Visual tokens**: status, severity, confidence, and trend glyphs
- **Phase model**: five phases with valid transitions

Capabilities import these by name. The schema contract ensures consistent usage.

---

## Capabilities

| | Capability | Purpose |
|---|---|---|
| ⌂ | hej | Orientation and routing |
| ⛥ | visionera | Define project direction |
| ❈ | resonera | Structured deliberation |
| ⬚ | inspirera | External pattern analysis |
| ≡ | planera | Planning with acceptance criteria |
| ⧉ | realisera | Autonomous development |
| ⎘ | optimera | Metric-driven optimization |
| ⛶ | inspektera | Codebase health audit |
| ▤ | dokumentera | Documentation |
| ♾ | profilera | Decision profiling |
| ◰ | visualisera | Visual identity system |
| ⎈ | orkestrera | Multi-cycle orchestration |

---

## Routing Logic

When a request arrives, route to the matching capability using the five-layer dispatch model from Decision 42:

### Layer 1: Bare `/agentera` — delegate to hej

If the request is `/agentera` with no additional text, delegate immediately to hej. Hej performs state-aware routing by reading project artifacts (PLAN.md, TODO.md, HEALTH.md, etc.) and suggesting the most useful next capability. This is deterministic and never wrong.

### Layer 2: `/agentera <capability-name>` — direct route

If the request text exactly matches a capability name (case-insensitive, e.g., "resonera", "planera", "hej"), route directly to that capability without evaluating natural-language trigger patterns. This gives power users direct access and bypasses all NL matching.

### Layer 3: Natural language with high-confidence match

If the request is natural language (e.g., "help me think through this"), evaluate trigger patterns from capability schemas. Each trigger entry has a `priority` field (high, medium, low). Sum the priorities of all matched patterns per capability. If the highest-scoring capability meets the minimum threshold (medium or higher), route to it.

### Layer 4: Borderline match — disambiguation

If multiple capabilities score within the same priority tier (e.g., two capabilities both have high-priority matches), present a disambiguation prompt instead of silently choosing. List the matching capabilities with brief descriptions and ask the user to confirm or clarify.

### Layer 5: No match — fallback to hej

If no capability matches with sufficient confidence, route to hej for orientation. Hej handles greetings, status requests, and ambiguous inputs.

### Trigger Pattern Discovery

The trigger-to-capability map for Layers 3-4 is derived from schema files, not hardcoded here. To discover triggers:

```
For each capability directory in capabilities/:
  Read all YAML files in schemas/
  Extract the TRIGGERS group
  Collect all pattern strings and their priority from trigger entries
  Map each pattern to the capability name
```

This keeps the master SKILL.md thin: a dispatcher, not an encyclopedia. Adding a new capability means adding a directory with schemas; the routing logic adapts automatically.

### Trigger Pattern Discovery

The trigger-to-capability map is derived from schema files, not hardcoded here. To discover triggers:

```
For each capability directory in capabilities/:
  Read all YAML files in schemas/
  Extract the TRIGGERS group
  Collect all pattern strings from trigger entries
  Map each pattern to the capability name
```

This keeps the master SKILL.md thin: a dispatcher, not an encyclopedia. Adding a new capability means adding a directory with schemas; the routing logic adapts automatically.

---

## Safety rails

<critical>
- NEVER push to remote repos without explicit user instruction
- NEVER modify VISION.md or OBJECTIVE.md during execution cycles (only the user or the owning capability may change these)
- NEVER commit secrets or credentials to any artifact or file
- Respect artifact path resolution: check `.agentera/docs.yaml` for path overrides before accessing any agent-facing artifact
</critical>

---

## Exit signals

All capabilities use a consistent exit vocabulary:

| Signal | Meaning | Exit code |
|--------|---------|-----------|
| complete | Task finished successfully | 0 |
| blocked | Cannot proceed, needs human input -- stuck | 0 |
| escalated | Issue exceeds capability scope, handoff needed -- flagged | 0 |
| partial | Task partially done, more cycles needed -- waiting | 0 |

---

## Cross-skill integration

The twelve-skill suite is collapsed into a single bundled skill. Each capability's schemas define cross-capability artifact references using stable IDs. Cross-capability routing is handled by the trigger pattern discovery mechanism described in the Routing Logic section. Capabilities read from and write to the same artifact store (`.agentera/` for agent-facing, project root for human-facing), so inter-capability data flows through shared artifacts, not direct invocation.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/docs.yaml` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/docs.yaml` doesn't exist or has no mapping for a given artifact, use the default layout:

- Human-facing artifacts at the project root: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`, `VISION.md`
- Agent-facing artifacts in `.agentera/` as YAML: `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `session.yaml`, `objective.yaml`, `experiments.yaml`

---

## Directory Structure

```
skills/agentera/
  SKILL.md                          # This file
  protocol.yaml                     # Shared primitives
  capability_schema_contract.yaml   # Self-referential schema contract
  capabilities/
    hej/
      prose.md
      schemas/
        triggers.yaml
        artifacts.yaml
        validation.yaml
        exit.yaml
    resonera/
      prose.md
      schemas/
        triggers.yaml
        artifacts.yaml
        validation.yaml
        exit.yaml
    ... (12 capabilities total)
```

Validate any capability against the contract:

```bash
uv run scripts/validate_capability.py skills/agentera/capabilities/<name>
```

Self-validate the contract:

```bash
uv run scripts/validate_capability.py --self-validate
```
