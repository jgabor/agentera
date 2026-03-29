# agent-skills

Personal Claude Code skill marketplace. Six skills that form a connected ecosystem for
autonomous software development — from deliberation through building, optimizing, auditing,
and learning from your own decision patterns.

## Skills

| Skill | What it does |
|-------|-------------|
| [visionera](./skills/visionera/) | **Envision** — Deep creation and stewardship of VISION.md through codebase exploration, domain research, and aspirational challenge. |
| [resonera](./skills/resonera/) | **Deliberate** — Structured Socratic questioning before consequential decisions. Produces DECISIONS.md. |
| [inspirera](./skills/inspirera/) | **Research** — Analyzes an external resource and maps its concepts to your project. |
| [realisera](./skills/realisera/) | **Build** — Autonomous development loop that evolves a project one focused cycle at a time. |
| [optimera](./skills/optimera/) | **Tune** — Metric-driven optimization through systematic experimentation. |
| [planera](./skills/planera/) | **Plan** — Scale-adaptive planning (skip/light/full) with behavioral acceptance criteria bridging deliberation and execution. |
| [inspektera](./skills/inspektera/) | **Audit** — Codebase health assessment across six dimensions with confidence scoring and trend tracking. |
| [dokumentera](./skills/dokumentera/) | **Document** — DTC-first documentation creation, maintenance, and verification with DOCS.md coverage tracking. |
| [profilera](./skills/profilera/) | **Know thyself** — Mines session history to generate a decision profile other skills consume. |

### How they connect

```
                      profilera
                     (decision profile)
                      ↓ consumed by all
visionera ──→ resonera ──→ planera ──→ realisera ←──→ optimera
 (envision)    (think)       (plan)       (build)        (tune)
                  ↑                          ↑              ↑
                  └────── inspirera ─────────┘   inspektera─┘
                            (research)              (audit)
```

- **visionera** creates and stewards VISION.md through deep exploration and aspirational challenge
- **resonera** deliberates on what to build, producing DECISIONS.md
- **planera** decomposes decisions into plans with behavioral acceptance criteria (PLAN.md)
- **realisera** executes plan tasks (or reasons from VISION.md when no plan exists)
- **inspektera** audits health and feeds findings to planera for remediation plans
- **inspirera** feeds external patterns into realisera's cycles and optimera's hypotheses
- **profilera** calibrates all other skills to the user's decision-making patterns

### State artifacts

Each skill generates markdown artifacts in the target project (not in this repo):

| Artifact | Maintained by | Consumed by |
|----------|---------------|-------------|
| `VISION.md` | visionera, realisera | realisera, planera, inspektera |
| `DECISIONS.md` | resonera | planera, realisera, optimera, inspektera, profilera |
| `PLAN.md` | planera | realisera, inspektera |
| `PROGRESS.md` | realisera | planera, inspektera |
| `ISSUES.md` | realisera, inspektera | realisera, planera |
| `OBJECTIVE.md` | resonera, optimera | optimera |
| `EXPERIMENTS.md` | optimera | optimera |
| `HEALTH.md` | inspektera | realisera, planera, inspektera |
| `DOCS.md` | dokumentera | dokumentera, inspektera |
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
