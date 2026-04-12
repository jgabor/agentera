# Reduce realisera cycle entry token consumption

## Objective

Reduce the token footprint of a single realisera cycle against the lira repo by **20%** from the established baseline, measured across the **full cycle** (orient through log), with no loss of cycle quality.

The primary metric is the **full-cycle composite `peak_context + output_total`** tokens, where:

- `peak_context`: the maximum `cache_read_input_tokens + cache_creation_input_tokens` observed at any assistant message across the entire `with` transcript. Captures the widest point of the context window realisera holds at any moment during the cycle.
- `output_total`: the sum of `output_tokens` across all assistant messages in the `with` transcript. Captures the total verbosity of realisera's reasoning and implementation output.

Direction: lower. Unit: tokens.

Full-cycle composite was chosen over the originally-proposed pre-dispatch slice because realisera has discretion over whether to dispatch work to a sub-agent or self-implement in the parent session. For small, self-contained changes, realisera implements directly without calling `Task` / `Agent`, so the dispatch-based slice equals the full cycle. Making the metric explicitly full-cycle avoids a dynamic shape where the metric definition depends on realisera's runtime dispatch decision. The `--slice-before-tool` mechanism is retained in the harness as a diagnostic (breakdown includes pre-dispatch counters when dispatch occurs).

Raw `total`, underlying `cache_*` counters, `turns`, `tool_uses`, and per-artifact read attribution are preserved in the harness breakdown as secondary diagnostics, but the keep/discard decision uses the composite.

Baseline is established by the first harness run and recorded in EXPERIMENTS.md as Experiment 0. The 20% target is computed from that baseline once available. If the baseline is 35,000 tokens, the target is 28,000; a run at 30,000 tokens is a 14% improvement and not yet at target.

## Why this matters

Realisera is the most-invoked cycle skill in the suite: every autonomous-development flow runs through it. Unlike hej (which fires once per session), realisera fires once per cycle and cycles run in loops, so savings compound multiplicatively with cycle count. A 10k-token savings per cycle is a 100k-token savings over ten cycles, which is roughly half a day of typical autonomous-development work.

Full-cycle composite captures what realisera actually costs per invocation, inclusive of any self-implementation work. Sub-agent cost (when dispatch happens) is excluded by the vehicle's `--tools` allowlist which blocks `Task` / `Agent`; realisera either self-implements or hits the tool barrier. Sub-agent optimization is a separate objective ("realisera-subagent-token") that deserves its own harness once optimera supports multiple objectives (see TODO.md).

The measurement also doubles as a diagnostic. The per-artifact read attribution in the breakdown tells us whether the bottleneck is:

- **Orient-side**: realisera's step 1 pulls too much from PROGRESS.md, DECISIONS.md, HEALTH.md, VISION.md, TODO.md at cycle start
- **Analyze-side**: the analytics script or the "key source files" scan in step 2 reads more aggressively than necessary
- **SKILL.md / contract-side**: the instructions or inline contract values themselves bloat the system prompt

First experiments are expected to be diagnostic. The ranked top-contributors list and by-class breakdown (agentera_artifact vs realisera_asset vs root_artifact vs profile vs other) will point at which direction deserves the first optimization attempt. If the data implicates an artifact produced by another skill, the finding is surfaced to the user for scope expansion rather than silently edited outside scope.

## Measurement

Captured by the locked eval harness at `.optimera/harness`. The harness runs a hermetic Docker vehicle (`agentera-optimera-vehicle:1`, same image as hej-token) that bakes in a pinned copy of the host `claude` binary plus python3 and git, and mounts:

- the lira repo mounted **read-write** at `/workspace`, **cloned fresh per run via `git clone --local --no-hardlinks`** from `$HOME/git/lira` and checked out at commit `5a52fdc` (a mid-plan state with 1 task complete and 4 pending, so realisera reaches the normal cycle path instead of the plan-completion sweep short-circuit that fires when PLAN.md has no actionable work). The clone is isolated from the lira source tree and each run starts from an identical state. Realisera can perform real operations on the clone (git log, file writes, even commits), and the clone is thrown away at run end. Read-only was infeasible because realisera's workflow requires file writes and its safety rails correctly reject a read-only filesystem as `stuck` before reaching step 5.
- a realisera-only marketplace snapshot at `/plugins/agentera-realisera` mounted read-only, built fresh per run from the host's `skills/realisera/`
- the host OAuth credentials read-only at `/creds/`
- the host PROFILE.md read-only at `/profile/` (so realisera's profile read reflects real usage)
- a writable `/output` for transcripts, stderr, meta, and the reads log

Each run executes two conditions in sequence:

- `without`: `claude -p` with no `--plugin-dir` (baseline; realisera not mounted, agent improvises a development cycle from native tools)
- `with`: `claude -p` with `--plugin-dir /plugins/agentera-realisera` (realisera mounted, activates on trigger)

Claude is invoked with the same trigger prompt, same model, and same flags:

> "Run one development cycle on this project. Focus on Task 2 of the current plan."

The first sentence matches realisera's trigger patterns ("development cycle on this project") and reliably fires the skill. The second sentence pins realisera's task selection to Task 2 ("Fix backfill failure cascade" in the Dashboard State Lifecycle Bug Fixes plan at `5a52fdc`). Pinning eliminates task-selection non-determinism, which caused ~48% run-to-run variance when realisera freely chose between tasks of different research depth. The Orient reads (the main optimization target) are identical regardless of task; the task pin stabilizes the Research reads.

Model: `claude-sonnet-4-6`. Flags: `--output-format stream-json --verbose --no-session-persistence --dangerously-skip-permissions --max-budget-usd 1.50 --add-dir /workspace`.

**Tool allowlist**: the vehicle's `--tools` flag is `Read Glob Grep Bash Skill` (same as hej-token). It does NOT include `Task` or `Agent`. This prevents realisera from leaking cost into external sub-agents, keeping the full-cycle cost within the parent session. Realisera either self-implements (common for small fixes) or hits the tool barrier and reports a stuck status (uncommon at the pinned commit because pending tasks are tractable).

Stream-JSON transcripts and a PostToolUse Read hook log (one JSONL record per `Read` inside the container, same hook as hej-token) are captured to `.optimera/runs/<run_id>/`. Post-run helpers on the host (`parse_tokens.py`, `check_gates.py`, `aggregate_reads.py`) extract the metric, enforce gates, and rank read contributors. `parse_tokens.py` retains the `--slice-before-tool Task,Agent` flag for diagnostic use; the slice counters appear in the breakdown but the primary metric is the full-cycle composite.

The primary metric reported to optimera is `with.peak_context + with.output_total` (full-cycle). The `breakdown` field carries the composite, delta vs baseline, pre-dispatch counters (diagnostic), peak context, output total, cache totals, cache efficiency, turns, tool uses, read-class totals, and top-5 read contributors.

## Gates

All three must pass for an experiment to be kept. Pre-registered; gates are locked and cannot be loosened during optimization.

**Causal**: the `with` transcript must satisfy at least one of:

- A `Skill(realisera)` tool invocation (direct skill activation)
- A realisera step marker in assistant text (`─── ⧉ realisera ·`, `── step 1/8:`, `── step 2/8:`, `── step 3/8:`, or `── step 4/8:`)
- A `Task` or `Agent` tool_use event (proves realisera reached step 4 dispatch)

Zero signal = discard.

**Structural**: the `with` transcript must satisfy both of:

- Evidence that realisera reached Dispatch (step 5 in the `orient → select → research → plan → dispatch → verify → commit → log` sequence): either a `── step 5/8:` marker in assistant text, OR at least one `Task` / `Agent` tool_use event (direct evidence of attempted dispatch)
- Full-cycle composite is at least 5,000 tokens (floor to rule out "realisera aborted immediately")

Missing either = discard. Step 5 is the pre-registered threshold because reaching dispatch (or the self-implement decision that replaces it) means realisera completed the full orient-through-plan sequence and has a meaningful context footprint to measure.

**Regression**:

- `python3 scripts/validate_spec.py` must pass (new-error count against baseline = 0)
- `python3 scripts/eval_skills.py --skill realisera --dry-run` must pass

The structural gate is a floor, not a ceiling. Subtler quality regressions (a cycle that technically hits all signals but produces a less informative hypothesis) need manual inspection of the transcript. Every experiment log includes a pointer to the run dir so the final assistant text can be read before keeping.

## Constraints

- Realisera must complete its cycle through at least step 5 (dispatch or self-implement decision). The structural gate enforces this floor.
- `python3 scripts/validate_spec.py` must pass after every experiment (SPEC compliance preserved).
- `python3 scripts/eval_skills.py --skill realisera --dry-run` must pass (skill inventory still resolves).
- Project formatting rules (from MEMORY.md): no em-dashes, no hard wraps, colons for labels, middle dot (`·`) for headings.
- No modification to any of: `SPEC.md`, `scripts/generate_contracts.py`, other skills, `hooks/`, any `.agentera/` artifact other than `EXPERIMENTS.md`, or `scripts/eval_skills.py`.
- No push to any remote. Local commits only on the current branch when an experiment is kept.
- No modification to the eval harness (`.optimera/harness` and `.optimera/vehicle/`) during optimization cycles. Only the brainstorm can edit it, and only with explicit user approval.

## Scope

In scope (fair game for experiments):

- `skills/realisera/SKILL.md`: primary optimization target
- `skills/realisera/SKILL.md` frontmatter including `spec_sections`: indirect contract-size lever
- `skills/realisera/references/`: may add new split-out files to enable progressive disclosure
- `skills/realisera/templates/`: templates may be inlined, externalized, or restructured
- `skills/realisera/.claude-plugin/plugin.json`: version bumps only when a change is kept

Out of scope (never modified, even if data suggests wins there):

- `skills/realisera/references/contract.md`: auto-generated from SPEC.md by `scripts/generate_contracts.py`; direct edits will be clobbered on regeneration. Attack the generator input (realisera's `spec_sections` frontmatter) instead.
- `SPEC.md`, `scripts/generate_contracts.py`, and any other generator: cross-skill blast radius.
- All other `skills/*/` directories: if read-attribution data points at an artifact produced by another skill, surface the finding to the user and wait for a scope-expansion decision.
- `scripts/eval_skills.py`: the trigger prompt is a harness input, not a target. Changing it rewrites the baseline.
- `hooks/`, `tests/`, and any non-realisera project infrastructure.
- The lira repo itself. It is the measurement target, not an optimization target. Lira is mounted as a writable ephemeral clone, but the source is never modified.

## Baseline

To be established by Experiment 0. The first harness run will:

1. Build the realisera-only marketplace snapshot from `skills/realisera/` at agentera HEAD
2. Clone the lira repo and checkout commit `5a52fdc` in a per-run staging dir
3. Run the paired A/B in the hermetic vehicle (both conditions against the same clone)
4. Parse the transcripts (full-cycle counters as primary, pre-dispatch slice as diagnostic)
5. Apply causal, structural, and regression gates
6. Emit the full-cycle composite metric with breakdown
7. Write the numbers and run dir pointer to EXPERIMENTS.md as Experiment 0

The 20% target is computed from the Experiment 0 composite and recorded alongside the baseline.

## Measurement model and hermeticity tradeoffs

- **Model**: `claude-sonnet-4-6`. Representative of typical usage, affordable to iterate against. Optimizations that win on Sonnet mostly transfer to Opus; subtle ones may not.
- **Hermetic vehicle**: same Docker image as hej-token. Mandatory because the OAuth subscription auth path is incompatible with `claude --bare`. The vehicle bakes in the exact host claude binary version and mounts credentials read-only.
- **Per-run clone substrate**: each run creates a fresh `git clone --local --no-hardlinks` of lira inside the run dir, then `git checkout --detach` at commit `5a52fdc`. The clone is mounted read-write so realisera's workflow (which requires file writes to complete) can proceed. Reproducibility is preserved because the source commit is pinned and each run starts from an identical clone; mutations during a run affect only the ephemeral clone. This is a meaningful posture shift from hej-token's read-only mount, driven by realisera being a fundamentally write-oriented skill. The harness fails fast if the pinned commit cannot be resolved.
- **Baseline variance**: the A/B design filters baseline drift by measuring both conditions per run. If variance across three warm-up runs exceeds ~3% on the composite, escalate to the brainstorm and tighten the vehicle.
- **$ budget**: `--max-budget-usd 1.50` per claude invocation, so a paired A/B caps at ~$3 per run. Raised from the hej-token default of $0.75 after an early run showed the native-tools `without` condition capping out at $0.75 mid-work; the realisera cycle path is materially more expensive than the hej briefing path and needs the headroom.
