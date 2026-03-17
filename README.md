# agent-skills

Personal Claude Code skill marketplace. Each skill is a self-contained directory with a `SKILL.md` that Claude reads to acquire specialised behaviour.

## Skills

| Skill | Description |
|-------|-------------|
| [inspirera](./skills/inspirera/) | INSPIRERA — Inspect Navigated Source, Project Its Resonance, Extract Reusable Abstractions. Analyzes an external link and maps its concepts to one of your own projects. |

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
