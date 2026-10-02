# Vite+ 1.0 formatting and hook concessions

## Ownership

Oxfmt 0.70.0 and Oxlint 1.85.0, bundled with Vite+ 1.0.0, replace the separate
Markdownlint and Lefthook dependencies. `.vite-hooks/pre-commit` is the project
hook. The root `staged` task runs fixes, then scoped readers inside the native
hidden-partial-hunk snapshot. The old installed hook entry point remains a small
forwarder to this policy, not a second hook manager or configuration parser.

The readers retain the compact-state 10-second budget, Python/TypeScript parity,
local import-related tests, guards and whole-project typecheck. Arguments remain
separate process arguments; related paths are absolute, including option-like
and unusual filenames. No package, performance, capacity or release owner is
added to pre-commit. Local hooks prevent ordinary mistakes, not hostile bypass.

Dependency acquisition uses `VP_GIT_HOOKS=0` to prevent implicit activation.
Activation requires separate permission. Existing shared hooks/config are not
changed by this migration. Native activation is proved only in independent
disposable repositories. The native dispatcher needs `basename` as well as the
other documented OS tools; without it upstream can exit successfully without
running the project hook. An existing foreign `core.hooksPath` also prevents
activation; inspect `vp hooks status`, not just the command exit code.

## Markdown concession

This is formatting, not Markdownlint equivalence. Structural and policy
assertions are deliberately lost. The old `.markdownlint.json` already disabled
MD013, MD024, MD029, MD033, MD036, MD040, MD041 and MD060; their removal loses no
enabled assertion.

The remaining default-rule inventory is:

Rule identities were checked against the pinned
[Markdownlint 0.40.0 rule index](https://github.com/DavidAnson/markdownlint/blob/v0.40.0/lib/rules.mjs).

- Structural/content/link policy: MD001 (heading increments), MD011 (reversed
  links), MD014 (shell prompts), MD025 (single title), MD026 (heading punctuation),
  MD034 (bare URLs), MD042 (empty links), MD045 (image alt text), MD051 (fragments),
  MD052 (reference resolution), MD053 (reference definitions), MD059 (descriptive
  link text). Oxfmt does not replace these assertions.
- Style/layout: MD003, MD004, MD005, MD007, MD009, MD010, MD012, MD018, MD019,
  MD020, MD021, MD022, MD023, MD027, MD028, MD030, MD031, MD032, MD035, MD037,
  MD038, MD039, MD046, MD047, MD048, MD049, MD050, MD055, MD056 and MD058.
  Oxfmt can fix some whitespace, blank-line, list, fence and table formatting,
  but passing Oxfmt is not proof of any Markdownlint rule.
- MD043 (required headings), MD044 (proper names) and MD054 (allowed link/image
  styles) were not given restrictive project settings. Their configurable checks
  are no longer available either.

There is no replacement custom Markdown linter. Test fixtures include Markdown
that formats successfully while retaining structural violations.

## Formatting scope and exceptions

Root `vite.config.ts#fmt` is the formatting authority for root and package
invocations. Print width remains 320; `.editorconfig` now agrees. Editors must use
the root Vite+ formatter configuration and respect exclusions, not substitute an
independent format-on-save policy. The CLI parity test checks package inheritance.

Maintained root Markdown, docs, package Markdown and maintainer skill guidance
are explicitly eligible. No YAML/protocol source expansion is made merely to
adopt Markdown formatting. Existing byte/purpose boundaries remain:

- All `.agentera/**`, especially typed writer-owned entities, plus `TODO.md`
  and `CHANGELOG.md`.
- All `references/**`, `docs/plans/**` and `skills/*/references/contract.md`.
- The published `skills/agentera/SKILL.md` projection, whose line/digest contracts
  are not a prose-formatting migration target.
- Package fixture/evidence trees, generated files, `dist`, `bundle` and dependencies.
- The two existing formatter/typecheck historical certification sources named
  in root config. Their exact evidence is not rewritten.

Excluded files are not formatted even when supplied explicitly to staged checks.
This does not exempt their artifact validation, compact checks, parity or other
scoped readers. No source budget or test assertion is reduced.
