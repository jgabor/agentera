# Parity EXPECTED/ACTUAL bug-demonstration template

Apply this pattern to `npmParityMatrix` / Python-oracle parity rows when fixing a
regression: land a **demonstrate** commit first, then a **fix** commit that only
flips the assertion.

## Workflow

1. **Demonstrate commit** — test passes on broken behavior; correct expectation
   preserved in a block comment (`EXPECTED`); wrong behavior asserted (`ACTUAL`).
2. **Fix commit** — delete comment markers and `ACTUAL` line; `EXPECTED` becomes the
   live assertion. No other edits in the fix commit.

## Minimal vitest shape

See `packages/cli/test/cli/parityExpectedActualTemplate.test.ts` for a runnable
micro-example. For real parity rows, mirror the pattern in the oracle fixture row
and `npmParityMatrix.test.ts` drift assertions.

## npmParityMatrix row

When adding a row to the parity matrix for a pre-existing bug:

- Register the row with `drift_direction: equal` as the target after fix.
- In the demonstrate pass, temporarily pin oracle shape to the **wrong** envelope
  or assert `ACTUAL` substring in a dedicated regression test.
- Fix pass restores `equal` against the corrected CLI output.

Do not apply EXPECTED/ACTUAL by default to every row — only where bisect clarity
justifies the two-commit ritual.
