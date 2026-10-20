# Verified native bootstrap

The two non-OIDC development setup jobs use native Vite+ **1.3.0** to manage
Node **24.22.0**, the `.node-version` pin, and pnpm **10.30.3**. Corepack is
not installed or executed. The checkout-free, action-free OIDC publisher is
unchanged. Hosted acceptance of the 1.3.0 bootstrap remains outstanding; local
proofs do not establish a passing hosted run. Earlier hosted runs used 1.0.0
(see [history](#vite-100-history)).

## Trust roots and selected bytes

The supported platform is Linux x64 glibc. The reviewed checkout, host process
and filesystem isolation, HTTPS trust store, and OS utilities are prerequisites.
`bootstrap-integrity.mjs` initially uses only trusted host Node built-ins and
`/bin/tar` with `/bin/gzip`. It reads the verified archive's single `vp` member
to stdout, not arbitrary archive paths into the host filesystem. Native children
also need `sh`, `sed`, `dirname`, and `uname` on the private PATH. No native
installer or separate OpenSSL executable is needed by this path.

The GitHub release API was rechecked on 2026-10-20:

- Immutable release `v1.3.0`, published 2026-10-16, source commit
  `afbe4a285b4ac6ffac498eae71b10ff63069a029` (the release target and tag
  commit).
- Asset `vp-x86_64-unknown-linux-gnu.tar.gz`, 4,758,934 bytes, SHA-256
  `3fb3a668472e1312eedd7598b3f6c511acebc2f6497c293a5ee04eba248eee7e`. The
  downloaded bytes matched the API digest.
- The helper checks that fixed digest before extraction or native execution.
  Missing, altered, or unavailable bytes fail closed. No installer, setup-vp
  action, mutable fallback, or dynamically learned digest is used.

Selected npm packages were separately checked on 2026-10-20 with the `sigstore`
4.1.1 library bundled in npm 11.19.1 of Vite-managed Node 24.22.0, without a new
dependency and with a fresh TUF cache. For each package, the SLSA v1 DSSE
signature, certificate chain, transparency-log inclusion (one Rekor `dsse` entry
with inclusion proof and promise), certificate issuer and identity, tarball
SHA-512 subject, workflow, source commit, and run passed verification. The
Fulcio certificate extensions also name the same source commit, run, and
signer. Negative controls failed as expected: an altered payload subject
(`TLOG_BODY_ERROR`) and a different workflow identity
(`UNTRUSTED_SIGNER_ERROR`).

| Artifact | SHA-512 SRI |
| --- | --- |
| `vite-plus@1.3.0` | `sha512-wZGsDeYfPcrCegqgY68pJJHGTpEZdsZvIMH2/mWXkGkBD72UY3M7z24Sv3ZeOL/FrqbbtyqBOfkKO6BvoQ8wMw==` |
| `@voidzero-dev/vite-plus-core@1.3.0` | `sha512-Bk/LBwNrxoB8XbGUtGJE3r+U9P4puvdZ6UH36ekygE1J+on/ytwM/yBgQwBnvmX6/MVax+2xxj8wk0N/KkyNeA==` |
| `@voidzero-dev/vite-plus-linux-x64-gnu@1.3.0` | `sha512-moxojk6zmog2SaLE4/cG75acE6X3cjR0/52Ba8OG2ct0r+dv55VSE0kellAuxS6o9VHy7TBhkIpwpFpQ34rnAA==` |

The signer is GitHub Actions (`https://token.actions.githubusercontent.com`),
identity `https://github.com/voidzero-dev/vite-plus/.github/workflows/release.yml@refs/heads/main`.
Upstream releases run on pushes to main, not tag-triggered runs. All three
attestations identify run `38853326369/attempts/1` and the selected source
commit. The bundled tools are Vite 8.3.4, Vitest 5.0.5, Oxlint 1.88.0, Oxfmt
0.73.0, and oxlint-tsgolint 7.0.2004; `vite-plus` declares Node
`^22.18.0 || ^24.11.0 || >=26.0.0`. The native npm package contains the Node
addon, not the standalone launcher. Do not claim that its npm attestation
authenticates the separate GitHub asset. That asset's boundary is the reviewed
immutable release and fixed checksum.

Sources:

- <https://api.github.com/repos/voidzero-dev/vite-plus/releases/tags/v1.3.0>
- <https://registry.npmjs.org/vite-plus/1.3.0>
- <https://registry.npmjs.org/@voidzero-dev/vite-plus-core/1.3.0>
- <https://registry.npmjs.org/@voidzero-dev/vite-plus-linux-x64-gnu/1.3.0>
- <https://github.com/voidzero-dev/vite-plus/blob/afbe4a285b4ac6ffac498eae71b10ff63069a029/.github/workflows/release.yml>

## Acquisition and isolation

Every CI bootstrap starts with fresh HOME, VP_HOME, XDG roots, temporary
directory, empty npm user/global configs, dependency store and npm cache. Its
constructed child environment does not inherit npm tokens/config, OIDC request
variables, Node options/module paths, runtime/package-manager overrides, mirror
or proxy settings, or ambient JavaScript executables. A project `.npmrc` fails
closed rather than loading ignored credentials or mirror overrides. Checkout
code and checked-in manifests remain trusted, not adversarial inputs.

Native managed mode is enabled only in that private profile. The repository Node
and package-manager declarations must match the exact pins before project
commands run. Vite+ obtains official Node releases with mandatory signed
`SHASUMS256.txt.asc` verification against its embedded Node release keys, then
checks the archive SHA-256 before extraction. The helper does not allow an
inherited custom mirror, where upstream permits checksum-only acquisition.

pnpm's reviewed tarball SRI is
`sha512-yWHR4KLY41TsqlFmuCJRZmi39Ey1vZUSLVkN2Bki9gb1RzttI+xKW+Bef80Y6EiNR9l4u+mBhy8RRdBumnQAFw==`.
The same bytes are encoded in `PNPM_REFERENCE`. The helper uses **`vp env exec
pnpm`** with `VP_PACKAGE_MANAGER` and `VP_PNPM_VERSION` carrying that reference
to verify a fresh manager download before execution. Plain `vp exec pnpm` can
resolve the project's unhashed manifest pin instead; it is not the integrity
acquisition entrypoint. Subsequent native installation uses that verified cache.

Frozen install retains lockfile integrity/store checks and root-local Vite+
version verification. Native install forwards pnpm-only flags after `--`.
Both CI jobs retain `--ignore-scripts`; contributor policy still allows only
esbuild. No task-result or dependency cache is added. The baseline proof verifies
the allowed and blocked lifecycle scripts separately.

After success, the private bin exposes the verified native `vp`, its managed
Node/npm/npx distribution, and digest-selected pnpm shim. Only then does CI
export its private PATH and config environment. Ordinary runner OS tools remain
behind it in later steps. This is not a sandbox against trusted checkout code
or an actor who can change the process, binaries, PATH, caches, or checkout.
Version output is a mistake/drift guard, not executable authenticity evidence.

Source review was performed at the 1.0.0 commit. On 2026-10-20 the same four
files were compared at the 1.3.0 commit. Node acquisition keeps the same hash
and signature verification path; the changes add an installation lock and
rename the semver crate. Package-manager acquisition still passes the expected
hash, and now also reads npm registry configuration, which the bootstrap
empties. The full diff was not re-reviewed line by line. The altered pnpm and
altered archive proofs below re-verified the fail-closed behavior on 1.3.0.

- <https://github.com/voidzero-dev/vite-plus/blob/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4/crates/vp_js_runtime/src/runtime.rs>
- <https://github.com/voidzero-dev/vite-plus/blob/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4/crates/vp_js_runtime/src/providers/node.rs>
- <https://github.com/voidzero-dev/vite-plus/blob/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4/crates/vp_pm_cli/src/package_manager.rs>
- <https://github.com/voidzero-dev/vite-plus/blob/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4/crates/vp_pm_cli/src/request.rs>
- <https://github.com/voidzero-dev/vite-plus/compare/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4...afbe4a285b4ac6ffac498eae71b10ff63069a029>

## Contributor and hosted boundaries

Contributors need no ambient Node or Corepack: obtain the native archive from
the trusted release and verify its fixed checksum before using it, then follow
`AGENTS.md#common-commands`. Do not substitute the Node-dependent npm shim for
first provisioning. macOS and Windows are not qualified by the Linux proof.

CI retains pinned `actions/setup-node` v6.3.0 at
`53b83947a5a98c8d113130e565377fae1a50d02f`, `.node-version` and
`package-manager-cache: false`. This is the trusted **bootstrap host** for the
small built-ins-only verifier, not the Node owner of later project commands.
Vite+ acquires and verifies a separate managed Node distribution in fresh roots.
Keeping the reviewed host action avoids introducing a second shell downloader
or an unverified installer. Historically, the proof succeeded from host Node
24.21.0 while project commands used 24.19.0, the managed pin at that time, so
host equality is no longer required.

Warm runtime/manager caches skip archive acquisition and verification. They are
trusted writable user state, not a security boundary against local tampering.
Warm dependency stores support `vp install --offline --frozen-lockfile`; first
use with empty caches still needs network. CI does not restore these caches.

## Executable proofs

From the repository root, use a **new** disposable evidence directory:

```bash
vp node packages/cli/scripts/prove-bootstrap-integrity.mjs /tmp/NEW_EVIDENCE_DIRECTORY
vp node packages/cli/scripts/verify-managed-toolchain.mjs
```

The first proof acquires verified native bytes and fresh managed runtime/manager
roots, installs a manifest-only fixture using the repository lockfile, builds
and executes TypeScript, rejects manifest drift and altered archives, and proves
warm offline success versus empty-cache failure. The second proves root-local
ownership, esbuild-only scripts, wrapper argument/cwd/exit behavior, acceptance
of a newer stable same-major launcher as unqualified, and rejection of wrong
managed Node, a prerelease launcher, or a stale launcher before project commands.
The bootstrap itself still accepts only the exact pinned launcher it downloaded. Neither writes
state, changes global tools, or activates checkout/shared hooks.

The [toolchain guide](../../docs/packaging/vite-plus-1-toolchain.md#contributor-setup)
summarizes contributor setup and links the final development qualification.
Historical compiler/formatter and hook certification remain separate owners.
Local success is not hosted approval.

## Vite+ 1.0.0 history

From 2026-10-02 until 2026-10-20 the bootstrap used native Vite+ 1.0.0. The
GitHub release API check on 2026-10-02 found immutable release `v1.0.0`, source
commit `fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4`, and asset
`vp-x86_64-unknown-linux-gnu.tar.gz` with SHA-256
`2adca8386c8f7e158eea4abe1a3eda9f89313c869145f788409a0be45979dd6a`.

Selected npm packages were checked with Sigstore verification from the npm
bundled in Vite-managed Node 24.19.0, the pin at the time of that check. The
SLSA v1 DSSE signatures, certificate issuer/identity, transparency evidence,
exact tarball SHA-512 subjects, workflow, and source commit passed verification
for the same signer identity as above. The main package attestation identified
run `36369459351/attempts/1`.

| Artifact | SHA-512 SRI |
| --- | --- |
| `vite-plus@1.0.0` | `sha512-2ezzBWt+AVO+I2F9Cpb2Of0J12Lat35kWZ/FRL2monMnKZuACKfkYAA/nMqdDo1KwB8sWjTKzmD9mRCh1Q1n+g==` |
| `@voidzero-dev/vite-plus-linux-x64-gnu@1.0.0` | `sha512-R6+/oVLCSEvatOG1utYo0d0I++QPjWuRt2moD21+UUu2mQ8VyZHaaQLgoxrQG9shA9o0RBDmwxhGUXL20Rk1FA==` |

The hosted runs recorded in the
[toolchain guide](../../docs/packaging/vite-plus-1-toolchain.md#qualification-and-performance)
used this 1.0.0 bootstrap. They are not evidence for 1.3.0.

Sources:

- <https://api.github.com/repos/voidzero-dev/vite-plus/releases/tags/v1.0.0>
- <https://registry.npmjs.org/vite-plus/1.0.0>
- <https://registry.npmjs.org/@voidzero-dev/vite-plus-linux-x64-gnu/1.0.0>
- <https://github.com/voidzero-dev/vite-plus/blob/fc287d7b1c0dc008dbc65d1d2b2f51a44e2a5ea4/.github/workflows/release.yml>

## Maintenance

- Maintainer: Agentera CLI maintainers
- Source checkout root: `.`
- Working directory: `.`
- Command: `pnpm -C packages/cli run test:toolchain-baseline` (invoke with `vp exec`
  so managed runtime ownership is retained).
