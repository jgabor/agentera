# Pinned bootstrap and workflow rollout

The four setup jobs now use the integrity-bound bootstrap described below.
The replaced setup-vp installer remains unverified; its old accepted-risk record
is **not acceptance evidence**. Hosted acceptance is still outstanding. The
credential-bearing publisher is unchanged. Historical compiler/formatter
certification is not re-run here.

## Trust root and pins

The supported proof host is Linux with the repository's exact `.node-version`
runtime provisioned by a trusted host. Node and `/bin/sh`, the reviewed checkout,
and the filesystem/process isolation provided by that host are prerequisites.
It is not a sandbox against an actor able to rewrite that checkout or process.
Node 24 does **not** imply that Corepack is installed. The caller must supply
the path to the Corepack **0.35.0** `dist/lib/corepack.cjs` file. Missing bytes or
a different digest stop before loading it; there is no installation fallback.
The helper copies the checked bytes to a fresh directory before loading them,
so it does not execute the host's unchecked launcher or resolve host packages.

Pin provenance, retrieved 2026-09-10 over HTTPS from the npm registry:

- `https://registry.npmjs.org/corepack/0.35.0` identifies git commit
  `4210ff8b4dba03ab347098c3f59225f34cb05652` and tarball
  `https://registry.npmjs.org/corepack/-/corepack-0.35.0.tgz`, integrity
  `sha512-9BuIGHDFE7Zieor1CeRsvt7X7AJFEuJ6OnbSbsVprq83ChDFoBh1wP98NeUS9FT3ZwlzFllPElXcz/OiDf0YGw==`.
  After verifying this archive (without executing it), its bundled
  `package/dist/lib/corepack.cjs` SHA-512 was compared with the provisioned host
  file. The fixed bundle digest is `COREPACK_SHA512` in the helper.
- `https://registry.npmjs.org/pnpm/10.30.3` declares tarball integrity
  `sha512-yWHR4KLY41TsqlFmuCJRZmi39Ey1vZUSLVkN2Bki9gb1RzttI+xKW+Bef80Y6EiNR9l4u+mBhy8RRdBumnQAFw==`.
  `PNPM_REFERENCE` encodes those same SHA-512 bytes in hexadecimal.
- Vite+ **0.3.0** and all installed build components retain the repository's
  `pnpm-lock.yaml` integrity authority and `pnpm-workspace.yaml` catalog pins.
  The proof does not generate a replacement lockfile or execute an installer.

These are reviewable registry-derived pins, not an independently verified SLSA
attestation. A reviewer must trust the selected upstream release bytes before
approving them. No runtime metadata response may replace an expected digest.

## Mechanism

Corepack documents `name@version+algorithm.hex` integrity in `packageManager`
and accepts the same version reference for `install --global`. For pnpm 10.30.3,
Corepack 0.35.0 hashes the downloaded tarball, compares before publishing its
installation or running pnpm, and does not hash just the executable entry file.
Corepack's existing-cache path skips downloading and checking bytes; therefore
every proof uses a newly created `COREPACK_HOME`, not inherited cached success.

The helper uses only host Node built-ins until the fixed Corepack bundle has
been checked. Children receive a constructed credential-free environment,
private config/store/cache directories, and a PATH containing only explicitly
provisioned Node and sh. Frozen pnpm installation retains lockfile integrity
checks and uses `--ignore-scripts`. This is the stricter existing build-job
lifecycle policy, not a relaxation of the esbuild-only contributor policy.

Sources:

- <https://github.com/nodejs/corepack/blob/v0.35.0/README.md>
- <https://github.com/nodejs/corepack/blob/v0.35.0/sources/corepackUtils.ts>

## Workflow deployment and acceptance boundaries

The trusted hosted baseline is GitHub's Linux runner, its action runtime and
filesystem/process isolation, the reviewed checkout, and the Node/npm
distribution provisioned by `actions/setup-node` **v6.3.0**, pinned to
`53b83947a5a98c8d113130e565377fae1a50d02f`. The action uses `.node-version`
(**24.19.0**) and `package-manager-cache: false`, with no registry-auth setup.
Its Node distribution acquisition/tool cache is a trusted prerequisite, not
something the Corepack/pnpm proof independently authenticates. Host `/bin/tar`
and `/bin/gzip` are also trusted utilities. Local checks require the same Node
version and its colocated `lib/node_modules/npm`; there is no global npm fallback.

`bootstrap-integrity.mjs` downloads the exact Corepack archive above using Node
built-ins and verifies its fixed archive SHA-512 **before extraction**. Trusted
tar/gzip emit only `package/dist/lib/corepack.cjs` to stdout; no archive paths are
unpacked into the host. The existing bundle digest check and private copy then
apply before Corepack is loaded. Missing, altered, or unavailable prerequisites
fail closed; no installer or dynamically learned digest is a fallback.

The helper creates fresh homes, stores, caches and empty npm configs, installs
the integrity-bound pnpm, and runs the unchanged frozen lockfile with store
integrity checking. The two ordinary verification jobs retain the workspace's
esbuild-only lifecycle allowlist. `verify-development` and `build-development`
retain `--ignore-scripts`. No dependency cache is restored or saved; authoritative
Vite task `cache: false` settings and the eleven development gates are unchanged.

After successful installation, a private bin directory exposes the selected
Node, npm/npx from that same trusted distribution, a pnpm launcher with the explicit
version/digest, and the lockfile-installed Vite+ **0.3.0** entrypoint. All are
checked before exporting the private PATH and config environment across steps.
Later steps retain ordinary runner tools behind this directory. This is not a
sandbox against trusted checkout code, nor a claim that later tools cannot
modify PATH. No runner-global package installation or configuration is changed.
The root contributor vocabulary (`vp install`, `vp check`, `vp run ...`) is
unchanged; initial CI installation uses the helper rather than an unverified
global Vite+ installer.

Acceptance is deliberately split:

1. **Local pre-merge evidence:** credential-free execution of both clean install
   variants, the deployment trust-boundary and workflow-contract tests, and
   meaningful local Agentera build/package smoke. This does not qualify a hosted
   job or authorize registry mutation.
2. **Hosted pre-merge acceptance:** both ordinary `verify-changes.yml` jobs must
   pass on a clean hosted checkout. This gate remains outstanding until separately
   authorized hosted execution supplies evidence.
3. **Actual publication jobs:** the exact `publish.yml` jobs run only after a
   separately authorized integration and push to the configured development ref.
   PR verification is not their execution evidence. There is no special
   publication dry-run workflow. Neither local proof nor hosted PR success
   authorizes that integration, push, or publication.

The OIDC publisher remains checkout-free, action-free and setup-free; its logic
and the exact-tarball construction/smoke steps are unchanged.

Action input authority:
<https://github.com/actions/setup-node/blob/53b83947a5a98c8d113130e565377fae1a50d02f/action.yml>.

## Running and interpreting the proof

From the assigned checkout, with the pinned trusted Node selected:

```bash
node packages/cli/scripts/prove-bootstrap-integrity.mjs \
  /provisioned/corepack/dist/lib/corepack.cjs \
  /tmp/opencode/NEW-UNUSED-EVIDENCE-DIRECTORY
```

The parent evidence directory must exist; the requested final directory must
not exist. The proof retains `report.json`, install/build logs and disposable
fixtures. It copies only the two dependency manifests, workspace config and
unchanged lockfile into a representative TypeScript library fixture. It does
not duplicate the checkout, qualify the whole Agentera build, or reuse its
`node_modules`. The build invokes `node_modules/vite-plus/bin/vp` explicitly
with no global tools on PATH and asserts the emitted module's exported value.
There is no task cache in this direct build; existing authoritative `cache:
false` settings are untouched.

The proof also uses trusted host `/bin/tar` and `/bin/gzip` solely to construct
a valid malicious test archive, never to execute downloaded bootstrap code.
A local HTTP server supplies that archive or HTTP 503. Separate fresh homes
prove rejection of altered pnpm bytes, altered locked dependency bytes, and
unavailable pnpm inputs after a prior successful installation. Altered/missing
host Corepack checks run before that. Executable markers must remain absent.
These boundary cases are part of the proof runner; source tests additionally
retain cheap pin and missing/altered prerequisite regression checks.

Local Linux x64 evidence on 2026-09-10 passed all six report checks under
Node 24.19.0, Corepack 0.35.0, pnpm 10.30.3 and local Vite+ 0.3.0. This is
mechanism evidence only: no hosted job has run this replacement.

## Maintenance

- Maintainer: Agentera CLI maintainers
- Source checkout root: `.`
- Working directory: `.`
- Command: `pnpm -C packages/cli run test:toolchain-baseline`
