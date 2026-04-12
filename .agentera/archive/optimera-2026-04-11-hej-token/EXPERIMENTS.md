# Experiments

## Experiment 0 · 2026-04-11 17:20 · baseline

**Hypothesis**: not a hypothesis. Baseline measurement to lock the starting metric and map the read pattern for future diagnostics.

**Method**: ran the locked harness at `.optimera/harness` once against the agentera repo at HEAD. Hermetic Docker vehicle (`agentera-optimera-vehicle:1`), `claude-sonnet-4-6`, paired A/B (`with` = hej-only marketplace mounted; `without` = no plugins). Hermeticity flags strip MCP cloud servers, host agents, and default tool surface; PostToolUse Read hook wired via `--settings /opt/bench/settings.json` captures per-artifact attribution. Raw run at `.optimera/runs/20260411T172055Z/`.

**Change**: none.

**Metric** (with hej, composite `peak_context + output_total`): **31,345 tokens**

**Baseline** (without hej, same composite): 31,201 tokens.

**Delta (hej's additive cost under composite)**: +144 tokens. At the widest-point measure, hej is effectively the same footprint as an unstructured native-tools session — the agent without hej improvises a full repo scan that peaks at similar context size. The raw `total` tells a different story (hej adds ~34% there), but raw total is 30% variance-prone; the composite is the decision metric.

**Context shape**:
- peak_context: 31,173 tokens (single-turn max)
- output_total: 172 tokens
- raw total (secondary): 464,402 tokens
- raw baseline total: 345,661 tokens
- turns: 19
- tool_uses: 12
- cache_efficiency: 0.7519

**Run-to-run stability** (three baseline runs, post-hermeticity):
- Run A: peak 29,901 + output 785 = 30,686
- Run B: peak 31,633 + output 136 = 31,769
- Run C: peak 31,173 + output 172 = 31,345
- Composite range: 30,686 – 31,769 (3.5% spread)
- Raw total range: 421,439 – 556,335 (32% spread) — the reason the primary metric is the composite, not raw total

**Read attribution** (effective bytes, limit-aware):

| Class | Effective bytes | Share |
|-------|-----------------|-------|
| hej_asset (contract.md) | 24,118 | 56% |
| agentera_artifact | 15,124 | 35% |
| root_artifact | 3,200 | 7% |
| profile (PROFILE.md head) | 400 | 1% |
| **total** | **42,842** | **100%** |

**Top effective contributors**:

| # | Path | Eff bytes | Read with |
|---|------|-----------|-----------|
| 1 | `references/contract.md` | 24,118 | full, no limit |
| 2 | `.agentera/DOCS.md` | 9,524 | full, no limit |
| 3 | `TODO.md` | 1,600 | limit 20 |
| 4 | `.agentera/PROGRESS.md` | 1,600 | limit 20 |
| 5 | `.agentera/HEALTH.md` | 1,600 | limit 20 |
| 6 | `VISION.md` | 1,600 | limit 20 |
| 7 | `.agentera/PLAN.md` | 1,600 | limit 20 |
| 8 | `.agentera/DECISIONS.md` | 1,600 | limit 20 |
| 9 | `.agentera/OBJECTIVE.md` | 1,600 | limit 20 |
| 10 | `PROFILE.md` | 400 | limit 5 |

**Regression**: n/a (no change to regression against).

**Status**: ▨ baseline recorded. Not kept or discarded · reference point for all future experiments.

**Conclusion**: two load-bearing findings that shape the optimization strategy.

1. **The bottleneck is consumer-side, not source-side.** Hej already applies `limit: 20` to every operational artifact (DECISIONS.md, HEALTH.md, PROGRESS.md, etc.), which caps each at roughly 1,600 effective bytes no matter how fat the source file is on disk. The 76 KB DECISIONS.md and 41 KB HEALTH.md look alarming in raw-size rankings but contribute only ~1.6 KB each to the session. Slimming those artifacts at the producer side (profilera, realisera, inspektera extraction verbosity) would have near-zero impact on hej's token cost. The fix lives in hej.

2. **Two full-file reads dominate.** `references/contract.md` (24 KB) and `.agentera/DOCS.md` (9.5 KB) are pulled with no limit. Together they are 78% of every byte hej loads. `contract.md` alone is 56% of the read footprint. These two files are the highest-leverage optimization targets.

**Variance note**: three post-hermeticity runs of `with.total` landed at 421K, 464K, and (pre-hook-fix) 556K tokens — ~30% spread. The variance traces to claude's run-to-run non-determinism in cache_creation vs cache_read split. The more-stable composite `peak_context + output_total` held at 31–32K across runs (<5% spread), which may be the better lock for optimization signal. Flagged for brainstorm refinement.

**Target (derived, composite primary metric)**: 20% of 31,345 = 6,269 tokens to cut. Goal: **≤ 25,076 tokens** in the `with` condition, gates still passing. In read-footprint terms that is roughly half of the 42,842 effective bytes hej currently consumes.

**Next**: queued experiment 1 (approved in brainstorm):

**Experiment 1 hypothesis**: rewrite hej's Step 0/1 instructions so `references/contract.md` is read lazily — index only on activation, specific sections pulled just-in-time from each step that references them. Contract.md is 56% of hej's effective-bytes footprint (24,118 B); a 50% reduction alone is a ~12 KB effective-bytes win, and the composite metric should drop proportionally because the loaded context shrinks. Risk: contract values are load-bearing for several steps; lazy loading requires the steps to know which section to pull and when, so the SKILL.md edits need to be careful. Regression check will catch SPEC compliance drift.

**Experiment queue** (post-#1):
- Reduce `spec_sections` frontmatter to the minimum any step actually references (further shrinks contract.md at source)
- Apply `limit` to the `.agentera/DOCS.md` read (currently full-file, 9.5 KB)
- Split hej's SKILL.md into lean entry + progressive references to cut its own ~11.5 KB baseline

Each runs in isolation with full A/B re-measurement.

---

## Experiment 1 · 2026-04-11 17:50 · contract.md lazy-reference

**Hypothesis**: hej's prose directive `Before starting, read references/contract.md` triggers an unlimited 24,118-byte read on every activation, but hej's briefing template already inlines every contract value it uses (severity arrows, trend arrows, skill glyphs, staleness heuristic). Replacing the upfront read with a lazy-reference note should eliminate the single largest entry in hej's effective-bytes footprint without affecting briefing output or routing behavior.

**Method**: dispatched a Sonnet implementation sub-agent to an isolated worktree (`.claude/worktrees/agent-ac70d76d`) with a scope restricted to the "### Contract" block in `skills/hej/SKILL.md`. The sub-agent replaced the 1-line upfront-read directive with a 2-paragraph lazy-reference block that inlines the specific contract values hej uses and downgrades `references/contract.md` to an on-demand spec reference. No other files touched.

**Change**: `skills/hej/SKILL.md` line 48 · 1-line upfront contract read directive replaced with 3-line inline-values + lazy-reference block.

**Metric** (primary, composite `peak_context + output_total`):

| | before | after | delta |
|---|---|---|---|
| primary (with) | 31,252 | **22,029** | **⮉ -9,223 (-29.5%)** |
| peak_context | 31,091 | 21,707 | -9,384 |
| output_total | 161 | 322 | +161 (briefing slightly wordier, still within structural gate) |
| raw_total (secondary) | 451,019 | 338,694 | -112,325 (-24.9%) |
| effective read bytes | 45,242 | 17,200 | -28,042 (-62%) |
| contract.md reads | 1 × 24,118 B full | **0** | eliminated |

**Gates**: both pass.

| gate | signal |
|---|---|
| causal | Skill(agentera-hej:hej) invoked once, agentera logo present, `─── status ───` section present |
| structural | 205 words, `/optimera` routing suggestion, all briefing sections rendered |
| regression (validate_spec) | 1 error (pre-existing em-dash in optimera SKILL.md) == baseline 1 · no new error |
| regression (eval_skills --skill hej --dry-run) | resolved |

**Regression**: pass (delta against baseline error count is zero).

**Status**: ■ kept.

**Commit**: `perf(hej): lazy-reference contract.md, drop upfront 24KB read` (applied on current branch, local only).

**Conclusion**: the hypothesis confirmed with margin. The 29.5% composite reduction is well past the 20% objective target (25,076 ≥ 22,029). The experiment also refutes the milder concern that hej "needed" contract.md to produce a correct briefing: the agent rendered the full status / attention / next sections, routed to `/optimera`, and used every inlined glyph correctly. The directive to read contract.md was vestigial.

Worth noting the briefing became *slightly* wordier (output 161 → 322) because the agent composed its opener and options text with more latitude, not because quality degraded. The wider context is now ~10k tokens leaner, so the agent has more room to think rather than compressing to save space.

Target **achieved**. Objective can now be re-framed as either (a) stretch goal past the first win, (b) lock 22,029 as the new baseline and pursue further reductions, or (c) declare the first pass complete and shift to a different optimization track (contract regeneration with reduced `spec_sections`, SKILL.md slimming).

**Next**: queued experiment 2 was `spec_sections` frontmatter reduction, which now has lower expected value because contract.md is no longer being read. Better candidates:

1. `limit` the remaining full-file `DOCS.md` read (9.5 KB currently, 2 reads limit 20 + limit 50 = ~5.6 KB effective, partial win available). Expected save: ~1–2k composite tokens.
2. Compress hej's SKILL.md itself (11.5 KB, 233 lines): move verbose sections (formatting rules block, cross-skill integration table, getting-started) to progressively-disclosed `references/` files. Potential save: ~3–5k composite tokens because the SKILL.md content is part of the system prompt that hej fires against.
3. Pause the loop: the objective has been met, further experiments are a stretch. Escalate to user for direction.
