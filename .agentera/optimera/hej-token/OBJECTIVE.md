# Reduce hej session token consumption

## Objective

Reduce the token footprint of a single hej session against the agentera repo by **20%** from the established baseline, with no loss of briefing completeness.

The primary metric is the **composite `peak_context + output_total`** tokens measured from a pinned `claude -p` session where hej fires on a state-heavy project (the agentera repo itself). Direction: lower. Unit: tokens.

- `peak_context` = the maximum single-turn `cache_read_input_tokens + cache_creation_input_tokens` across all assistant messages. Captures the widest point of the context window the session actually had to hold: system prompt + tool descriptions + accumulated file reads + prior turns.
- `output_total` = the sum of `output_tokens` across all assistant messages. Captures how much the agent had to generate.

This composite was chosen over the raw `input + cache_creation + cache_read + output` sum because the raw sum is dominated by `cache_read` which accumulates multiplicatively with turn count and is extremely sensitive to claude's run-to-run sampling non-determinism (observed ~30% variance across three identical baseline runs). The composite held within ~5% across the same runs and directly reflects what we want to reduce: the work hej forces into the session's widest context window plus the verbosity of the reply.

The raw `total`, each underlying `cache_*` counter, `turns`, `tool_uses`, and `cache_efficiency` are preserved in the harness breakdown as secondary diagnostics for the Hypothesize step, but the keep/discard decision uses the composite.

Baseline is established by the first harness run and recorded in EXPERIMENTS.md as Experiment 0. The 20% target is computed from that baseline once available. If the baseline is 31,500 tokens, the target is 25,200 tokens; a session at 27,000 tokens is a 14% improvement and not yet at target.

## Why this matters

Hej is the skill that runs at the start of almost every session. Its cost compounds across every project and every day: a 10k-token savings per invocation scales into meaningful wall-clock and dollar reduction over a week of normal use. It is also the most read-heavy skill in the suite, which makes it the canary for the entire agentera artifact format: if hej costs too much, other skills that read the same artifacts cost too much too.

The measurement also doubles as a diagnostic. The per-artifact read attribution in the breakdown tells us whether the bottleneck is:

- **source-side**: the artifacts hej reads are bloated beyond their information content (profilera's extraction too verbose, PROGRESS.md not compacted aggressively enough, HEALTH.md listing every file by name, etc.). In that case the fix lives in the producing skill, not in hej.
- **consumer-side**: hej reads entire files when it only needs the head, or reads artifacts it could infer from others. In that case the fix lives in hej (smarter Read limits, pre-filter scripts, progressive disclosure of references).

First experiments are expected to be diagnostic: the ranked top-contributors list and by-class breakdown (agentera_artifact vs hej_asset vs root_artifact vs profile vs other) will point at which direction deserves the first optimization attempt. If the data implicates an artifact produced by another skill, the finding is surfaced to the user for an explicit scope expansion decision rather than silently edited outside scope.

## Measurement

Captured by the locked eval harness at `.optimera/harness`. The harness runs a hermetic Docker vehicle (`agentera-optimera-vehicle:1`) that bakes in a pinned copy of the host `claude` binary plus python3 and git, and mounts:

- the target repo read-only at `/workspace`
- a snapshot of the hej skill dir read-only at `/plugins/hej`
- the host OAuth credentials read-only at `/creds/`
- the host PROFILE.md read-only at `/profile/` (so hej's read pattern reflects real usage)
- a writable `/output` for transcripts, stderr, meta, and the reads log

Each run executes two conditions in sequence:

- `without`: `claude -p` with no `--plugin-dir` (baseline; hej not mounted, agent improvises a briefing from native tools)
- `with`: `claude -p` with `--plugin-dir /plugins/hej` (hej mounted, activates on the trigger prompt)

Claude is invoked with the same trigger prompt, same model (`claude-sonnet-4-6`), same flags (`--output-format stream-json --verbose --no-session-persistence --dangerously-skip-permissions --max-budget-usd 0.75 --add-dir /workspace`). The trigger prompt reused from `scripts/eval_skills.py`:

> "Start a new session and give me a status briefing on this project."

Stream-JSON transcripts and a PostToolUse-hook read log (one JSONL record per `Read` inside the container) are captured to `.optimera/runs/<run_id>/`. Post-run helpers on the host (`parse_tokens.py`, `check_gates.py`, `aggregate_reads.py`) extract the metric, enforce gates, and rank read contributors.

The primary metric reported to optimera is `with.peak_context + with.output_total`. The `breakdown` field carries the raw total (for legacy comparison), delta vs baseline under the composite metric, peak context, output total, cache read/create totals, cache efficiency, turns, tool uses, read-class totals, and top-5 read contributors.

## Gates

Both must pass for an experiment to be kept. Pre-registered; gates are locked and cannot be loosened during optimization.

**Causal**: the `with` transcript must contain either a `Skill(hej)` tool invocation OR one of hej's signature output markers (the agentera logo strings, `─── status ───`, `─── attention ───`, `─── next ───`). Zero signal = discard.

**Structural quality**: the final assistant text in the `with` condition must contain (a) a status-section marker, (b) at least one routing suggestion naming a known agentera skill (`/visionera`, `/realisera`, etc.), (c) at least 50 words. Missing any = discard.

The structural gate is a floor, not a ceiling. Subtler quality regressions (a briefing that is technically complete but meaningfully less informative) need manual inspection of the transcript. Every experiment log includes a pointer to the run dir so the final assistant text can be read before keeping.

## Constraints

- Hej must continue to deliver a complete briefing (structural gate enforces the floor; visual review catches nuance).
- `python3 scripts/validate_spec.py` must pass after every experiment (SPEC compliance preserved).
- `python3 scripts/eval_skills.py --skill hej --dry-run` must pass (skill inventory still resolves).
- Project formatting rules (from MEMORY.md): no em-dashes, no hard wraps, colons for labels, middle dot (`·`) for headings.
- No modification to any of: `SPEC.md`, `scripts/generate_contracts.py`, other skills, hooks/, any `.agentera/` artifact other than `EXPERIMENTS.md`, or `scripts/eval_skills.py`.
- No push to any remote. Local commits only on the current branch when an experiment is kept.
- No modification to the eval harness (`.optimera/harness` and `.optimera/vehicle/`) during optimization cycles. Only the brainstorm can edit it, and only with explicit user approval.

## Scope

In scope (fair game for experiments):

- `skills/hej/SKILL.md` — primary optimization target
- `skills/hej/SKILL.md` frontmatter including `spec_sections` — indirect contract-size lever
- `skills/hej/references/` — may add new split-out files to enable progressive disclosure
- `skills/hej/.claude-plugin/plugin.json` — version bumps only when a change is kept

Out of scope (never modified, even if data suggests wins there):

- `skills/hej/references/contract.md` — auto-generated from SPEC.md by `scripts/generate_contracts.py`; direct edits will be clobbered on next regeneration. Attack the generator input (hej's `spec_sections` frontmatter) instead.
- `SPEC.md`, `scripts/generate_contracts.py`, and any other generator — cross-skill blast radius.
- All other `skills/*/` — out of scope. If read-attribution data points at an artifact produced by another skill (say, profilera's PROFILE.md extraction), surface the finding to the user and wait for a scope-expansion decision.
- `scripts/eval_skills.py` — the trigger prompt is a harness input, not a target. Changing it would rewrite the baseline.
- Hooks, tests, and any non-hej project infrastructure.

## Baseline

Established by Experiment 0 at `.optimera/runs/20260411T172055Z/`.

- **Primary metric** (`peak_context + output_total`, with hej): **31,345 tokens**
- 20% target: `31,345 × 0.8 = 25,076 tokens`. Need to save at least **6,269 tokens** in the composite to hit the objective.
- Raw `total` at baseline (now secondary, kept for reference): 464,402 tokens
- Baseline `without` hej under composite: 31,201 tokens (baseline agent's peak+output is roughly the same as hej's — hej's structured read pattern is not dramatically larger than ad-hoc exploration at the widest-point measure)

The composite metric refinement landed at the end of the brainstorm after three baseline runs revealed that raw `total` variance (30%) would swamp any realistic 20% optimization signal. The harness emits the composite as `metric` from that point forward; prior run dirs retain enough transcript detail that the composite can be re-derived from them.

## Measurement model and hermeticity tradeoffs

- **Model**: `claude-sonnet-4-6`. Representative of typical usage, affordable to iterate against (~$0.05 per paired A/B run). Optimizations that win on Sonnet mostly transfer to Opus; subtle ones may not.
- **Hermetic vehicle**: Docker is mandatory because the OAuth subscription auth path is incompatible with `claude --bare`. The vehicle bakes in the exact host claude binary version and mounts credentials read-only; state artifacts, hej source, and the target repo all live on bind mounts the container cannot write to.
- **Baseline variance**: the A/B design filters baseline drift by measuring both conditions per run. If variance across three warm-up runs exceeds ~3%, escalate to the brainstorm and tighten the vehicle (e.g., pin the base image by digest, disable network race conditions, add warm-up runs before measurement).
- **$ budget**: `--max-budget-usd 0.75` per claude invocation, so a paired A/B caps at ~$1.50 per run.
