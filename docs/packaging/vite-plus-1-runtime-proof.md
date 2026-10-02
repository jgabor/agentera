# Vite+ 1.0 runtime proof

Task 3 only, recorded 2026-10-02 in the assigned `vite-plus-1-toolchain`
checkout. State, lifecycle completion, commits and pushes remain with Prime.
No global tool changes, shared-hook activation, new workflow, publication, or
package optimization was performed.

## Result

The existing development verification/build bootstrap now checks the immutable
Linux x64 native Vite+ 1.0.0 archive before extraction or execution. It enables
managed mode in fresh private roots, acquires Node 24.19.0 and integrity-bound
pnpm 10.30.3, then installs the authoritative frozen lockfile. Corepack is no
longer needed or executed by this bootstrap. Existing workflow invocations
already select the helper, so `publish.yml` required no change at all.

Current runtime guards, baseline component/provenance authority and contributor
guidance select 1.0.0. The baseline confirms Vite 8.3.1, Vitest 5.0.1, Oxlint
1.85.0, and Oxfmt 0.70.0. The root Vite alias and manager/Node pins are unchanged
from task 2. At this proof's checkpoint, Lefthook and Markdownlint remained for
their assigned later task. Task 4 replaces them; see the formatting concession
record and hook proof. The commands below retain the actual task 3 evidence.

## Verification

Host Node was v24.21.0; all project commands used the separately acquired
Vite-managed v24.19.0. Native archives came from the immutable release and
passed the fixed checksum before use. For ordinary checks, a built-ins-only
host launcher read the proof's `environment.json`, invoked its absolute native
`vp`, and appended `/usr/bin:/bin` behind the private managed tools. This did not
use or change a global launcher/profile. The two bootstrap proof commands below
were invoked with host `node` to demonstrate that the project runtime does not
depend on host version equality.

| Command                                                                                                                                                                                                                                                     | Observed result                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node packages/cli/scripts/prove-bootstrap-integrity.mjs /tmp/opencode/agentera-task3-bootstrap-proof-7`                                                                                                                                                    | Pass, nine checks. Exact managed pins and managed npm/npx entrypoints; frozen install and build; no inherited npm/OIDC settings; altered/missing inputs rejected; warm offline operation makes no requests; empty caches fail without ambient fallback. |
| `node packages/cli/scripts/verify-managed-toolchain.mjs`                                                                                                                                                                                                    | Pass. Live lifecycle policy allows esbuild and blocks an unlisted script. Root wrappers preserve cwd, arguments, failure and uncached execution. Node 24.20.0 and stale Vite+ 0.3.0 fail before project-command markers.                                |
| `vp test run packages/cli/test/validate/bootstrapIntegrity.test.ts packages/cli/test/validate/toolchainBaseline.test.ts packages/cli/test/release/routineCiOwnership.test.ts --reporter=json --outputFile=/tmp/opencode/agentera-task3-targeted-tests.json` | Pass, 21 tests in three files; no failed or pending assertions.                                                                                                                                                                                         |
| `vp lint` with the five changed runtime/proof scripts and two changed validation tests                                                                                                                                                                      | Pass, zero errors and warnings.                                                                                                                                                                                                                         |
| `vp run typecheck`                                                                                                                                                                                                                                          | Pass, `tsc -p tsconfig.json --noEmit`.                                                                                                                                                                                                                  |
| `vp run build`                                                                                                                                                                                                                                              | Pass, current local CLI built with synchronized extraction parity and nine staged data surfaces.                                                                                                                                                        |
| `vp node packages/cli/dist/bin/agentera.js check validate retained-references`                                                                                                                                                                              | Pass after retaining the runbook inventory's exact maintenance command.                                                                                                                                                                                 |
| `vp exec markdownlint --dot` with the seven changed Markdown files                                                                                                                                                                                          | Pass.                                                                                                                                                                                                                                                   |
| `git diff --check` and `git diff --exit-code -- .github/workflows/publish.yml`                                                                                                                                                                              | Pass. No workflow change, including the entire fixed OIDC job.                                                                                                                                                                                          |

The lockfile hash before/after the managed proof was unchanged:
`39fd37117892985244e3bd4acf15d4c829d8ec6cc8356847b496f81acb03b9d5`.

Evidence locations (disposable, not package contents):

- `/tmp/opencode/agentera-task3-bootstrap-proof-7/report.json`,
  `environment.json`, `runtime.json`, `install.log`, `build.log`,
  `warm-offline-*.log` and `negative-requests.json`.
- `/tmp/opencode/agentera-task3-managed-toolchain.log`.
- `/tmp/opencode/agentera-task3-targeted-tests.json`.
- `/tmp/opencode/agentera-task3-retained-references.json`.
- `/tmp/opencode/agentera-task3-provenance-3/`: main npm package metadata,
  SLSA bundle, signed statement, TUF verification state and passing result.
- `/tmp/opencode/agentera-task3-native-provenance/`: equivalent passing npm
  platform-addon provenance verification. The addon is not the standalone asset.

The disposable provenance verifiers used Sigstore already bundled with managed
Node's npm, a private TUF cache, exact certificate issuer/identity, fixed SRI,
tarball subject digest, source commit and workflow binding. Their commands were
credential-free `env -i` invocations of the managed Node binary, with
`/tmp/opencode/verify-vp-provenance.mjs` and
`/tmp/opencode/verify-vp-native-provenance.mjs` as inputs. No dependency was added
to the checkout. Selected proof identities and digests are retained in
`references/analysis/toolchain-baseline.yaml`.

Early probes exposed native argument/entrypoint differences (pnpm shims need
OS shell utilities, pnpm-only install flags need `--`, and digest acquisition
requires `vp env exec`). They were corrected. The listed evidence is from the
final passing proofs, not those failed probes.

## Security boundary and retained exceptions

- Native authenticity uses a reviewed immutable GitHub release and a fixed
  whole-archive checksum. npm SLSA verification covers the main npm package and
  platform addon separately; it is not asserted for the standalone release asset.
- Managed official Node acquisition verifies signed checksums; pnpm acquisition
  checks the fixed tarball digest before execution. Fresh CI profiles avoid
  trusting inherited warm caches.
- Installation children receive constructed private config, cache and PATH
  environments, not inherited npm/OIDC credentials or runtime/mirror settings.
  A project `.npmrc` now rejects the isolated bootstrap rather than loading it.
- Version guards detect mistakes and drift. They are not security boundaries
  against binary spoofing or modification by trusted checkout code.
- Pinned setup-node remains only as the trusted CI host for the built-ins-only
  verifier. Vite+ owns the separately verified project runtime. The fixed OIDC
  publisher, publication policy, job permissions and single-push boundary are
  unchanged.
- Warm caches support offline use, not first-time provisioning or protection
  against a local actor who can rewrite them. Linux x64 glibc is qualified;
  macOS, Windows and musl are not.

Hosted CI was not run. Full source/release qualification belongs to the later
owner and was not repeated. The hook-bootstrap fixture's current runtime pins
were updated, but its execution was skipped because it creates worktrees,
commits and activates hooks; none of those actions is authorized in this task.
Historical formatter/typecheck certification pins remain historical, not current
runtime guards.
