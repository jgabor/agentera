# Native-hook fixture follow-up

## Scope and cause

This is local comparison evidence for the Vite+ 1.0 toolchain, not release qualification or a performance claim. The implementation baseline is `544163f621c523c6c9bbdff9ef1470b81bd66e07` on `vite-plus-1-toolchain`.

The reported hosted run `36969918102` failed eight native-hook cases when the fixture installer inherited `VP_GIT_HOOKS=0`. Vite+ can report a successful skipped installation with a disable flag set. The generated dispatcher also checks the disable flags at hook execution. Enabling only the installation subprocess would not prove commit-time checks.

`packages/cli/test/scripts/nativeHooks.test.ts` now sets `VP_GIT_HOOKS`, `VITE_GIT_HOOKS`, and `HUSKY` to `1` only for commands whose working directory is an owned disposable fixture. Checkout commands keep the caller's environment. The installation assertion includes the output from enable, status, and the local Git config query.

Fixture repositories, dispatch probes, and related-test reports live under the ignored disk-backed `.vitest/followup/hooks/` directory. Dependencies remain symlinks to the installed checkout dependencies. Fixture children honor a supplied `TMPDIR`; otherwise they use `.vitest/followup/hooks/tmp/`. Each fixture has its own `pnpm-workspace.yaml` with no child packages, which stops native workspace discovery from reaching the enclosing checkout. An initial local run without that boundary failed 10 of 26 tests; native checks did not stay inside the fixture. The boundary fixes that failure without changing the checked policy.

The new regression starts with all three outer flags at `0`, installs a fixture hook, and makes a normal Git commit. A final staged task records a hook trace with flags `["1", "1", "1"]` and formatted Markdown. The test checks the committed bytes, checks that the outer flags are still `["0", "0", "0"]`, and checks that a checkout subprocess also sees those disabled values. The disposable trace is removed with its fixture after the assertion.

Existing assertions remain: reader selection and failure propagation, staged fixes before readers, partial-hunk preservation, odd filenames, renames, deletions, byte-stable exclusions, parse failures, missing local binary rejection, installed-reader negative cases, legacy bridge behavior, Git environment isolation, and owner discovery. Hook flags are test isolation, not a security boundary. Real checkout activation and CI's installation guard are unchanged.

The bounded correction also changes `packages/cli/test/config/formatterSurface.test.ts` fixture location and command working directory. Every formatter fixture now honors the selected `TMPDIR`, with a disk-backed `.vitest/followup/hooks/tmp/` fallback. The clean/drift case reuses the independent workspace fixture, puts eligible files under `packages/cli`, and runs the formatter from that fixture. Its existing workspace/config boundary, dependency symlink, root/package/editor checks, byte-stable exclusions, and Markdown assertions remain. No ignore policy was disabled or changed.

## Local verification

Environment: Linux x64, standalone Vite+ 1.0.0, local Vite+ 1.0.0, actual managed Node.js 24.19.0, and pnpm 10.30.3. Checks ran serially. Test timeouts and budgets were not increased.

From the assigned checkout root:

```bash
VP_GIT_HOOKS=0 VITE_GIT_HOOKS=0 HUSKY=0 \
  TMPDIR="$PWD/.vitest/followup/hooks/tmp" \
  vp env exec --node 24.19.0 ./node_modules/.bin/vp test run \
  packages/cli/test/scripts/nativeHooks.test.ts --maxWorkers 1 \
  --reporter default --reporter json \
  --outputFile .vitest/followup/hooks/evidence/native-hooks-corrected.json \
  > .vitest/followup/hooks/evidence/native-hooks-corrected.log 2>&1

VP_GIT_HOOKS=0 VITE_GIT_HOOKS=0 HUSKY=0 \
  TMPDIR="$PWD/.vitest/followup/hooks/tmp" \
  vp env exec --node 24.19.0 ./node_modules/.bin/vp test run \
  packages/cli/test/config/formatterSurface.test.ts --maxWorkers 1 \
  --reporter default --reporter json \
  --outputFile .vitest/followup/hooks/evidence/formatter-surface-corrected.json \
  > .vitest/followup/hooks/evidence/formatter-surface-corrected.log 2>&1
```

| Check                                              | Result                                                        |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Native-hook file                                   | 26 passed, 0 failed, 0 skipped; one file passed               |
| Disabled-parent probe before the complete run      | 1 passed, 25 filtered out; not used as complete-file evidence |
| Formatter functional file after bounded correction | 4 passed, 0 failed, 0 skipped; one file passed                |
| Historical formatter run before correction         | 3 passed, 1 failed, 0 skipped; retained, superseded           |

`vp env exec --node 24.19.0 ./node_modules/.bin/vp fmt --check packages/cli/test/scripts/nativeHooks.test.ts packages/cli/test/config/formatterSurface.test.ts docs/packaging/vite-plus-1-followup-hooks.md` passed for all three changed files. `git diff --check -- packages/cli/test/scripts/nativeHooks.test.ts packages/cli/test/config/formatterSurface.test.ts` also passed.

The historical formatter failure was `accepts clean input and rejects formatting drift`: its clean file was created under the ignored `.vitest/followup/hooks/tmp/` directory, then checked from the checkout without a fixture workspace boundary. The formatter excluded that target and reported `Expected at least one target file`. The bounded correction resolves that fixture-location mismatch. The final four passing cases cover maintained-source configuration, acceptance of clean input and rejection of drift, root/package/editor width and byte-stable exclusions, and eligible Markdown formatting. All final tests ran without filtering or skips; formatter ran first, then native hooks.

## Isolation and retained evidence

The shared Git config at `/home/jgabor/git/agentera/.git/config` had this SHA-256 before and after the focused runs:

```text
9cdfae3b8c7e3a3c19ee88be8cbe7510d2426b25ab017c3ec790f52bf72912b0
```

No shared hooks were activated or edited. No global Git config, tmpfiles settings, root config, workflow, typed state, or cache-test implementation was changed by this task. Git commits occurred only inside disposable fixture repositories. No checkout commit, push, integration, or publication was performed.

Evidence is retained at `.vitest/followup/hooks/evidence/`: final `native-hooks-corrected.{log,json}` and `formatter-surface-corrected.{log,json}`, earlier `native-hooks-final.{log,json}`, the historical failed `formatter-surface.{log,json}`, `disabled-parent-probe.{log,json}`, and the initial `native-hooks.{log,json}` failure record. After the corrected runs, the hooks directory used about 3.2 MiB (120 KiB evidence and 3.1 MiB temporary/cache data). The checkout filesystem had about 221 GiB free; `/tmp` had about 8.2 GiB free. These are end-of-run observations, not peak-use measurements. Owned fixtures were cleaned; existing evidence and temporary data were not deleted. All formatter fixtures in the corrected run used the disk-backed selected TMPDIR. No short-path IPC workaround was needed.

Full source, package, performance, bootstrap, and release owners were not run. Hosted CI has not yet verified this patch. Cache work remains with its separate owner. The formatter location mismatch is resolved; this evidence is ready for comparison, not broader qualification.
