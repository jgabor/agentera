<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>Skill suite</strong> for autonomous software development.

Install and type <code>/hej</code> to begin:

```bash
npx skills add jgabor/agentera
```

<br>

![](https://img.shields.io/badge/skills-12-444?style=flat-square)
![](https://img.shields.io/badge/license-Apache_2.0-444?style=flat-square)

</div>

---

Type `/hej` and agentera reads your entire project (code, git history, open issues, health grades) and tells you where things stand:

```
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────

  ⛶ health    ⮉ B+ (testing: C)
  ⇶ issues    0 critical · 2 degraded · 5 annoying
  ≡ plan      [██████▓░░░] 6/10 tasks
  ♾ profile   loaded

  Shipped auth middleware and rate limiting last cycle.
  Health trending up, test coverage still lagging.

─── attention ──────────────────────────

  ⇉ test coverage below 60%, degrading since cycle 8
  ⇉ task 7 blocked on API schema decision

─── next ───────────────────────────────

  suggested → ❈ /resonera (resolve API schema to unblock task 7)
```

Every skill suggests what to do next when it finishes. You follow the thread, or run `/orkestrera` to execute an entire plan: it dispatches skills, evaluates each task with inspektera, retries failures, and loops until done.

---

## Skills

|     | Skill                                | What it does                                                                                                         |
| :-: | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
|  🞔  | [hej](./skills/hej/)                 | **Entry point.** Reads your project state, shows what needs attention, suggests where to start.                     |
|  ⛥  | [visionera](./skills/visionera/)     | **Envision.** Defines and evolves your project's north star through codebase exploration and aspirational challenge. |
|  ❈  | [resonera](./skills/resonera/)       | **Deliberate.** Thinks through hard decisions via Socratic questioning before you commit.                           |
|  ⬚  | [inspirera](./skills/inspirera/)     | **Research.** Analyzes an external resource and maps its patterns to your project.                                  |
|  ≡  | [planera](./skills/planera/)         | **Plan.** Breaks work into tasks with clear done-criteria, scales from quick notes to full plans.                   |
|  ⧉  | [realisera](./skills/realisera/)     | **Build.** Autonomous development loop that picks up work, implements, verifies, and continues.                     |
|  ⎘  | [optimera](./skills/optimera/)       | **Tune.** Picks a metric, runs experiments, measures results, iterates until it improves.                           |
|  ⛶  | [inspektera](./skills/inspektera/)   | **Audit.** Audits code health across nine dimensions (architecture, patterns, coupling, complexity, tests, deps, versioning, artifact freshness, security), tracks trends over time. |
|  ▤  | [dokumentera](./skills/dokumentera/) | **Document.** Creates and maintains docs, tracks what's covered and what's missing.                                 |
|  ♾  | [profilera](./skills/profilera/)     | **Compounding memory.** Mines your decision patterns into a profile consumed by every skill, so the 20th cycle adapts to how you work in ways the 1st could not. |
|  ◰  | [visualisera](./skills/visualisera/) | **Visualize.** Creates and maintains a visual identity system for your project.                                     |
|  ⎈  | [orkestrera](./skills/orkestrera/) | **Orchestrate.** Dispatches skills as subagents, evaluates each with inspektera, loops through plans. |

## How it works

Skills communicate through markdown files in your project: a vision doc, a plan, a health report, a decision log. Each skill reads what the others have written and acts on it. You don't manage these files; they build up naturally as you work.

```
(simplified: each skill has additional cross-skill edges, see spec Section 7)

                       🞔 hej
                    (entry point)
                     ↓ routes to
                      ♾ profilera
                  (compounding memory)
                    ↓ consumed by all
⛥ visionera ──→ ❈ resonera ──→ ≡ planera ──→ ⎈ orkestrera ──→ ⧉ realisera ←──→ ⎘ optimera
  (envision)      (think)       (plan)        (orchestrate)     (build)          (tune)
     ↕              ↑          ↑  ↑               ↕                 ↑
  ◰ visualisera  ▤ dokumentera┘   │       ⛶ inspektera──────────────┘
    (design)      (document)      │          (evaluate + audit)
                  ⬚ inspirera ────┤
                   (research)     ↓
                         realisera, optimera,
                         visionera, resonera
```

visionera writes a north star → planera reads it and creates tasks → orkestrera dispatches skills as subagents to execute the plan → realisera builds, inspektera audits, optimera tunes → findings feed back into the next planning cycle. profilera watches how you make decisions and tunes every skill to your preferences. The loop tightens over time.

<details>
<summary><strong>State artifacts reference</strong></summary>

<br>

Three project-facing files at root, nine operational files in `.agentera/`.

**Root (project-facing)**:

| Artifact       | Maintained by         | Consumed by                    |
| -------------- | --------------------- | ------------------------------ |
| `VISION.md`    | visionera, realisera  | realisera, planera, inspektera, dokumentera, visualisera, orkestrera |
| `TODO.md`      | realisera, inspektera | realisera, planera, orkestrera |
| `CHANGELOG.md` | realisera             | project contributors           |

**.agentera/ (operational)**:

| Artifact         | Maintained by | Consumed by                                         |
| ---------------- | ------------- | --------------------------------------------------- |
| `PROGRESS.md`    | realisera     | planera, inspektera, dokumentera, visionera, orkestrera                     |
| `DECISIONS.md`   | resonera      | planera, realisera, optimera, inspektera, profilera, orkestrera |
| `PLAN.md`        | planera       | realisera, inspektera, orkestrera                               |
| `HEALTH.md`      | inspektera    | realisera, planera, orkestrera                                  |
| `OBJECTIVE.md`   | optimera      | optimera                                            |
| `EXPERIMENTS.md` | optimera      | optimera                                            |
| `DESIGN.md`      | visualisera   | realisera, visionera                                |
| `DOCS.md`        | dokumentera   | all skills (path overrides)                         |
| `SESSION.md`     | session stop hook | session start hook, hej                         |

`PROFILE.md` is global. In Claude Code, the reference implementation stores it at `~/.claude/profile/PROFILE.md`. Other runtimes provide their own equivalent profile path through the host adapter contract.

</details>

---

<details>
<summary><strong>Installing</strong></summary>

<br>

> [!NOTE]
> The install steps below target [Claude Code](https://docs.anthropic.com/en/docs/claude-code), the current reference implementation. The portable core is defined in the spec; adapters for other runtimes will carry their own install instructions. `profilera` requires a session corpus per the Section 21 Session Corpus Contract and remains adapter-specific until the target runtime provides one.

### From the plugin registry

```bash
claude plugin add jgabor/agentera
```

### With npx

```bash
npx skills add jgabor/agentera
```

### Manual (git clone)

Clone the repo:

```bash
git clone git@github.com:jgabor/agentera.git ~/.claude/agentera
```

Add individual skills to your project's `.claude/settings.json`:

```json
{
  "skills": ["~/.claude/agentera/skills/inspirera"]
}
```

Or reference the repo globally in `~/.claude/settings.json` to make all skills available everywhere:

```json
{
  "skillPaths": ["~/.claude/agentera/skills"]
}
```

Pull updates at any time:

```bash
cd ~/.claude/agentera && git pull
```

</details>

<details>
<summary><strong>Using with OpenCode</strong></summary>

<br>

agentera skills are runtime-portable. The SKILL.md files load in OpenCode without modification; only the install paths differ.

**Global skill install** (symlink each skill into OpenCode's global skills directory):

```bash
for d in skills/*/; do
  ln -s "$(pwd)/$d" ~/.config/opencode/skills/$(basename "$d")
done
```

**Plugin install** (hooks for artifact validation and session continuity):

```bash
cp .opencode/plugins/agentera.js ~/.config/opencode/plugins/
```

**Profile path**: profilera writes `PROFILE.md` to `~/.config/opencode/profile/PROFILE.md` when running under OpenCode.

**Compatibility path**: OpenCode also discovers skills from `.claude/skills/` (Claude Code compatibility), so project-local installs work unchanged.

For full capability mapping, session corpus support, and sub-agent dispatch strategies, see [`references/adapters/opencode.md`](./references/adapters/opencode.md).

</details>
