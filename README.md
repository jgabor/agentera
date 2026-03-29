# agent-skills

Personal Claude Code skill marketplace. Each skill is a self-contained directory with a `SKILL.md` that Claude reads to acquire specialised behaviour.

## Skills

| Skill | Description |
|-------|-------------|
| [inspirera](./skills/inspirera/) | INSPIRERA — Insight Navigation: Source Pattern Identification and Resonance — Evaluate, Reframe, Assimilate. Analyzes an external link and maps its concepts to one of your own projects. |
| [realisera](./skills/realisera/) | REALISERA — Relentless Execution: Autonomous Loops Iterating Software — Evolve, Refine, Adapt. Autonomous development loop that evolves any project one focused cycle at a time. |
| [optimera](./skills/optimera/) | OPTIMERA — Objective Pursuit: Targeted Iterative Measurement — Experiment, Record, Advance. Metric-driven optimization loop that improves any measurable property of a codebase. |
| [resonera](./skills/resonera/) | RESONERA — Reflective Engagement: Socratic Observation Nexus — Explore, Reframe, Articulate. Structured deliberation through Socratic questioning before consequential decisions. |
| [inspektera](./skills/inspektera/) | INSPEKTERA — Integrity Navigation: Systematic Pattern Evaluation, Knowledge Tracing — Examine, Report, Advise. Codebase health audit with multi-dimensional evaluation and trend tracking. |
| [profilera](./skills/profilera/) | PROFILERA — Persona Reconstruction: Observable Footprint Indexing Logic — Examine, Reconcile, Articulate. Mines session history to generate an agent-consumable decision profile. |

---

## Installing in Claude Code

Clone the repo once:

```bash
git clone git@github.com:jgabor/agent-skills.git ~/.claude/skills
```

Then add individual skills to your project's `.claude/settings.json`:

```json
{
  "skills": [
    "~/.claude/skills/skills/inspirera"
  ]
}
```

Or reference the repo globally in `~/.claude/settings.json` to make all skills available everywhere:

```json
{
  "skillPaths": [
    "~/.claude/skills/skills"
  ]
}
```

Pull updates at any time:

```bash
cd ~/.claude/skills && git pull
```

---

## Adding a new skill

```
skills/
└── your-skill-name/
    └── SKILL.md          # required — frontmatter + instructions
    └── references/       # optional — supplementary docs
    └── scripts/          # optional — executable helpers
```

Then update `registry.json` and the table above.
