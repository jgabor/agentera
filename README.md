# agent-skills

Personal Claude Code skill marketplace. Six skills that form a connected ecosystem for
autonomous software development — from deliberation through building, optimizing, auditing,
and learning from your own decision patterns.

## Skills

| Skill | What it does |
|-------|-------------|
| [resonera](./skills/resonera/) | **Deliberate** — Structured Socratic questioning before consequential decisions. Produces DECISIONS.md. |
| [inspirera](./skills/inspirera/) | **Research** — Analyzes an external resource and maps its concepts to your project. |
| [realisera](./skills/realisera/) | **Build** — Autonomous development loop that evolves a project one focused cycle at a time. |
| [optimera](./skills/optimera/) | **Tune** — Metric-driven optimization through systematic experimentation. |
| [inspektera](./skills/inspektera/) | **Audit** — Codebase health assessment across six dimensions with confidence scoring and trend tracking. |
| [profilera](./skills/profilera/) | **Know thyself** — Mines session history to generate a decision profile other skills consume. |

### How they connect

```
                    profilera
                   (decision profile)
                    ↓ consumed by all
resonera ──→ realisera ←──→ optimera
  (think)      (build)        (tune)
    ↑              ↑              ↑
    └── inspirera ─┘   inspektera┘
        (research)      (audit)
```

- **resonera** produces VISION.md and OBJECTIVE.md that drive realisera and optimera
- **inspirera** feeds external patterns into realisera's cycles and optimera's hypotheses
- **inspektera** files health findings to ISSUES.md for realisera to fix, and triggers resonera for architectural decisions
- **profilera** calibrates all other skills to the user's decision-making patterns

### State artifacts

Each skill generates markdown artifacts in the target project (not in this repo):

| Artifact | Maintained by | Consumed by |
|----------|---------------|-------------|
| `VISION.md` | resonera, realisera | realisera, inspektera |
| `DECISIONS.md` | resonera | realisera, optimera, inspektera, profilera |
| `PROGRESS.md` | realisera | inspektera |
| `ISSUES.md` | realisera, inspektera | realisera |
| `OBJECTIVE.md` | resonera, optimera | optimera |
| `EXPERIMENTS.md` | optimera | optimera |
| `HEALTH.md` | inspektera | realisera, inspektera |
| `PROFILE.md` | profilera | all skills |

---

## Installing

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

Then update `registry.json`, the skills table above, and `.claude-plugin/marketplace.json`.
