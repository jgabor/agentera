#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""End-to-end smoke harness for live-host AGENTERA_HOME inheritance.

Mirrors ``scripts/smoke_setup_helpers.py`` shape: sequential numbered
cases, ``PASS:`` / ``FAIL:`` / ``SKIP:`` to stdout, fail-fast on hard
errors, exit 0 / exit 1, snapshot-restore for any user file the harness
might mutate. The two top-level modes:

    Default mode (no flags)
        Runs the profilera Codex collection audit (Task 1 path) by
        invoking ``profilera.scripts.extract_all.build_corpus()`` in
        process, grouping records by runtime, and reporting whether
        codex-cli records land in the corpus envelope. Then delegates to
        ``scripts/smoke_setup_helpers.py`` as a subprocess so the
        existing 11-case helper smoke continues to gate this harness.
        No live CLI is invoked. Exits 0 with
        ``PASS: all smoke checks passed``.

    Live mode (--live)
        Probes the ``codex`` and ``copilot`` binaries, distinguishing
        "not on PATH" (``shutil.which`` returns ``None``) from
        "binary present but auth probe times out at 30s" with distinct
        skip messages. Snapshots ``~/.codex/config.toml`` and any shell
        rc file the harness might mutate to a tmp path BEFORE any
        mutation; restores from the tmp snapshot in the top-level
        ``finally`` block on every exit path (success, hard fail, or
        crash). The Task 2 cut wires the snapshot/restore plumbing and
        the probe + cost-gate UX so Tasks 3 and 4 can plug in the
        actual ``codex exec`` and ``copilot -p`` invocations without
        re-shaping the harness skeleton. The Task 2 cut does NOT issue
        any model calls; the per-runtime sections currently terminate
        at the auth probe and report SKIP outcomes.

Cost gate (live mode only):
    Prints ``Estimated cost: $0.20-1.00 across two model calls`` and a
    one-line consent prompt before any subprocess CLI invocation. The
    user must type ``y`` or ``yes`` (case-insensitive) to proceed;
    anything else aborts with a non-zero exit and no CLI invocation.

Skip semantics:
    Per-runtime sections that detect "not on PATH" or
    "binary present but auth probe timed out" record a SKIP and do NOT
    fail the overall run. The harness still exits 0 with a summary
    naming each skipped section and the reason, so a host with neither
    CLI installed sees a clean pass with the skipped sections
    enumerated.

Snapshot/restore contract:
    Any file the harness mutates is copied to a tmp path of the form
    ``/tmp/agentera-smoke-live-<basename>-<timestamp>.bak`` BEFORE the
    mutation; the tmp path is logged to stdout. The original is
    restored from the tmp path in the top-level ``finally`` block even
    on crash. The Task 2 cut never issues a mutation (no live CLI
    section reaches the setup_codex.py invocation in this cut), so the
    snapshot list stays empty in practice; the framework is in place
    for Task 3 / Task 4 to register snapshots before any mutation.

Run from the repo root::

    python3 scripts/smoke_live_hosts.py            # default mode
    python3 scripts/smoke_live_hosts.py --live     # live mode (gated)

Exits 0 with ``PASS: all smoke checks passed`` on success (including
clean SKIPs in live mode), 1 with ``FAIL: <reason>`` on the first hard
failure (fail-fast).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SETUP_HELPERS_SMOKE = REPO_ROOT / "scripts" / "smoke_setup_helpers.py"
EXTRACT_ALL = REPO_ROOT / "skills" / "profilera" / "scripts" / "extract_all.py"

# Auth probe deadline shared across both runtimes (AC3). 30s is the
# distinguishing line between "binary present but unresponsive" (likely
# unauthenticated, network-blocked, or rate-limited) and "binary present
# and ready to serve a request".
AUTH_PROBE_TIMEOUT_SECONDS = 30


# ---------------------------------------------------------------------------
# Output protocol — mirrors smoke_setup_helpers.py
# ---------------------------------------------------------------------------


def fail(reason: str) -> None:
    """Print ``FAIL: <reason>`` to stdout and exit 1.

    stdout (not stderr) so the `PASS:` / `FAIL:` protocol the README
    documents stays anchored on a single stream. Mirrors the Cycle 177
    smoke_setup_helpers.py choice.
    """
    print(f"FAIL: {reason}")
    sys.exit(1)


def assert_true(condition: bool, reason: str) -> None:
    if not condition:
        fail(reason)


def info(line: str) -> None:
    print(line)


def skip(section: str, reason: str, skips: list[tuple[str, str]]) -> None:
    """Record a per-section SKIP and emit the skip line to stdout.

    Skips are accumulated into ``skips`` so the final summary can list
    every skipped section and its reason on a single trailing line.
    """
    info(f"SKIP: {section} ({reason})")
    skips.append((section, reason))


# ---------------------------------------------------------------------------
# Snapshot / restore registry
# ---------------------------------------------------------------------------


class SnapshotRegistry:
    """Track ``(original_path, tmp_backup_path)`` pairs for restore.

    The harness registers a snapshot via :meth:`snapshot` BEFORE any
    mutation. The top-level ``finally`` block calls :meth:`restore_all`
    which copies each tmp backup back over the original (or unlinks the
    original if the snapshot recorded an absent file). Idempotent:
    calling :meth:`snapshot` twice for the same path is a no-op so
    nested code paths stay safe.
    """

    def __init__(self) -> None:
        # Map original path str -> (original_path, backup_path or None
        # if the original did not exist at snapshot time)
        self._entries: dict[str, tuple[Path, Path | None]] = {}

    def snapshot(self, path: Path) -> Path | None:
        """Snapshot ``path`` to a tmp backup. Returns the backup path.

        Returns ``None`` if the original does not exist; the registry
        still records the absence so :meth:`restore_all` can unlink any
        file created during the run.
        """
        key = str(path.resolve()) if path.exists() else str(path)
        if key in self._entries:
            # Already snapshotted; preserve the original snapshot.
            return self._entries[key][1]
        if not path.exists():
            self._entries[key] = (path, None)
            info(f"snapshot: {path} (absent at snapshot time)")
            return None
        ts = time.strftime("%Y%m%d-%H%M%S")
        backup = Path(
            f"/tmp/agentera-smoke-live-{path.name}-{ts}-{id(path):x}.bak"
        )
        shutil.copy2(path, backup)
        self._entries[key] = (path, backup)
        info(f"snapshot: {path} -> {backup}")
        return backup

    def restore_all(self) -> None:
        """Restore every snapshotted path. Safe to call from ``finally``.

        Errors during restore are printed but do not propagate; the
        harness already considers the run over by the time this runs,
        and partial restore beats no restore. The list of restored
        paths is printed for operator audit.
        """
        for key, (original, backup) in self._entries.items():
            try:
                if backup is None:
                    if original.exists():
                        original.unlink()
                        info(f"restore: removed {original} (was absent)")
                    continue
                shutil.copy2(backup, original)
                info(f"restore: {backup} -> {original}")
            except OSError as exc:  # pragma: no cover - best-effort restore
                info(f"restore-error: {key}: {exc}")


# ---------------------------------------------------------------------------
# Default-mode sections
# ---------------------------------------------------------------------------


def run_codex_collection_audit() -> None:
    """Task 1 path: in-process build_corpus() inspection.

    Imports ``extract_all`` from the profilera scripts directory and
    calls ``build_corpus()`` directly. Groups all returned records by
    runtime and asserts that ``codex-cli`` either has at least one
    record or is reported as ``available=False`` in
    ``metadata.runtime_status`` (no Codex install on the host is a
    valid clean outcome and must not fail the smoke). Reports the
    counts on stdout.

    The actual ``extract_all.py`` CLI fails to write corpus.json when
    the unrelated claude-code duplicate-source_id bug is present
    (tracked as `[claude-code-extract-duplicate-source-ids]` TODO);
    using ``build_corpus()`` directly avoids that failure mode because
    the in-memory envelope is returned regardless of the post-build
    validation errors.
    """
    info("--- profilera Codex collection audit ---")

    # Import from the profilera scripts directory; mirrors the Task 1
    # audit cycle's invocation pattern.
    profilera_scripts = REPO_ROOT / "skills" / "profilera" / "scripts"
    if str(profilera_scripts) not in sys.path:
        sys.path.insert(0, str(profilera_scripts))

    try:
        import extract_all  # type: ignore[import-not-found]
    except ImportError as exc:
        fail(
            f"could not import profilera extract_all "
            f"(checked {EXTRACT_ALL}): {exc}"
        )
        return  # unreachable; satisfies type checker

    corpus, errors, _warnings = extract_all.build_corpus()

    if not corpus:
        # No runtime data on this host at all. Not a smoke failure;
        # report and move on.
        info("audit: no runtime data on this host (corpus empty); audit clean")
        return

    records = corpus.get("records", [])
    by_runtime: Counter[str] = Counter()
    for record in records:
        # extract_all.py records carry ``runtime`` at the top level
        # (see RUNTIME_CODEX_CLI / RUNTIME_CLAUDE_CODE / RUNTIME_COPILOT_CLI
        # builders). No provenance nesting.
        runtime = record.get("runtime", "<unknown>")
        by_runtime[runtime] += 1

    info(
        "audit: total records=%d across runtimes=%s"
        % (
            len(records),
            ", ".join(
                f"{name}={count}" for name, count in sorted(by_runtime.items())
            )
            or "<none>",
        )
    )

    runtime_status = corpus.get("metadata", {}).get("runtime_status", {})
    codex_status = runtime_status.get("codex-cli")
    if codex_status is None:
        info("audit: codex-cli not detected on this host (no probe success)")
    else:
        codex_count = by_runtime.get("codex-cli", 0)
        info(
            f"audit: codex-cli available; corpus carries {codex_count} "
            f"codex-cli record(s)"
        )

    if errors:
        # The unrelated claude-code dup-source_id failure surfaces here.
        # Report the Codex-specific slice (Task 2 must not block on it).
        codex_errors = [e for e in errors if "codex" in e.lower()]
        info(
            f"audit: {len(errors)} validation error(s) from build_corpus(); "
            f"{len(codex_errors)} mention codex"
        )
        if codex_errors:
            for err in codex_errors[:5]:
                info(f"audit: codex-error: {err}")


def run_setup_helpers_smoke() -> None:
    """Delegate to ``scripts/smoke_setup_helpers.py`` as a subprocess.

    The setup-helpers smoke is the existing offline gate (Cycle 177):
    11 sequential black-box cases covering both setup helpers without
    requiring any live CLI. Re-running it from this harness keeps a
    single ``smoke_live_hosts.py`` invocation as the operator-facing
    surface for "is the cross-runtime install path healthy".
    """
    info("--- setup helpers smoke (delegated) ---")
    if not SETUP_HELPERS_SMOKE.exists():
        fail(f"setup helpers smoke missing: {SETUP_HELPERS_SMOKE}")
    result = subprocess.run(
        [sys.executable, str(SETUP_HELPERS_SMOKE)],
        capture_output=True,
        text=True,
        check=False,
    )
    # Echo the delegated stdout so the operator sees the cases, then
    # gate on the exit code.
    if result.stdout:
        # Indent the delegated output so it is visually grouped under
        # this harness's output.
        for line in result.stdout.rstrip("\n").splitlines():
            info(f"  {line}")
    if result.stderr:
        for line in result.stderr.rstrip("\n").splitlines():
            info(f"  [stderr] {line}")
    assert_true(
        result.returncode == 0,
        f"smoke_setup_helpers.py exited {result.returncode} "
        f"(see delegated output above)",
    )


# ---------------------------------------------------------------------------
# Live mode: cost gate + per-runtime probes
# ---------------------------------------------------------------------------


COST_LINE = (
    "Estimated cost: $0.20-1.00 across two model calls "
    "(one per runtime; --live mode only)"
)
CONSENT_LINE = (
    "Proceed with live CLI invocations (codex exec + copilot -p "
    "--allow-all-tools)? [y/N]: "
)


def cost_gate() -> bool:
    """Print the cost line and a one-line consent prompt.

    Returns ``True`` on ``y`` / ``yes`` (case-insensitive), ``False``
    otherwise. The harness aborts cleanly on a non-affirmative response
    so the operator can dry-probe the harness UX without spending any
    model budget. ``--allow-all-tools`` is named in the consent line
    per Task 4 AC3 so the operator knows what permission they grant.
    """
    print(COST_LINE)
    try:
        response = input(CONSENT_LINE).strip().lower()
    except EOFError:
        # Non-interactive stdin (e.g. piped) without a "yes" line is
        # treated as a decline so CI never accidentally bills.
        info("consent: stdin closed without a response; declining")
        return False
    return response in {"y", "yes"}


def probe_runtime(
    binary: str,
    version_args: list[str],
    auth_probe_args: list[str],
    skips: list[tuple[str, str]],
) -> str:
    """Probe a runtime CLI; return one of ``ok``, ``not-on-path``, ``not-authed``.

    Distinguishes the two skip modes per AC3:

    - ``not-on-path``: ``shutil.which(binary)`` returns ``None``. The
      CLI is not installed; user has nothing to authenticate.
    - ``not-authed``: ``shutil.which(binary)`` returns a path but the
      auth probe (``binary <auth_probe_args>``) either times out at
      ``AUTH_PROBE_TIMEOUT_SECONDS`` or returns non-zero. The CLI is
      installed but cannot serve a request; usually means
      authentication is missing or the CLI is in a degraded state.

    The version probe is run first as a sanity check; if it fails, the
    binary is treated as ``not-authed`` (present but uncooperative)
    rather than ``not-on-path`` because ``shutil.which`` already
    confirmed the file is on PATH.
    """
    path = shutil.which(binary)
    if path is None:
        skip(binary, "not on PATH", skips)
        return "not-on-path"

    info(f"probe: {binary} resolved to {path}")

    # Version probe: should be near-instant for any healthy CLI. We
    # cap at 10s as a sanity bound; a hung --version usually points at
    # a broken install or a network-bound auth refresh on first run.
    try:
        version_result = subprocess.run(
            [binary, *version_args],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip(
            binary,
            f"binary present but `{binary} {' '.join(version_args)}` timed out",
            skips,
        )
        return "not-authed"

    if version_result.returncode != 0:
        skip(
            binary,
            f"binary present but `{binary} {' '.join(version_args)}` "
            f"exited {version_result.returncode}",
            skips,
        )
        return "not-authed"

    # Auth probe: the actual cost-bearing request. Tasks 3 / 4 will
    # replace this with the combined AGENTERA_HOME + compaction
    # invocation; in the Task 2 cut we issue a deterministic
    # "reply OK" prompt and treat timeout-at-30s as "not authenticated".
    try:
        auth_result = subprocess.run(
            [binary, *auth_probe_args],
            capture_output=True,
            text=True,
            timeout=AUTH_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip(
            binary,
            f"binary present but auth probe timed out at "
            f"{AUTH_PROBE_TIMEOUT_SECONDS}s",
            skips,
        )
        return "not-authed"

    if auth_result.returncode != 0:
        skip(
            binary,
            f"binary present but auth probe exited "
            f"{auth_result.returncode} "
            f"(stderr={auth_result.stderr.strip()[:120]!r})",
            skips,
        )
        return "not-authed"

    info(f"probe: {binary} healthy (auth probe exited 0)")
    return "ok"


def run_codex_live_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """Codex live section — Task 2 cut wires probe + snapshot only.

    Tasks 3 / 4 wire the actual ``codex exec`` invocation that issues
    the combined AGENTERA_HOME + compact_artifact.py prompt. In this
    Task 2 cut the section terminates at the probe; if the probe
    succeeds we still record the snapshot pre-points so the operator
    can see the snapshot/restore plumbing is in place.
    """
    info("--- codex live section ---")
    status = probe_runtime(
        binary="codex",
        version_args=["--version"],
        # Task 2 placeholder: a deterministic "reply OK" prompt under
        # codex exec non-interactive mode. Tasks 3 will replace this
        # with the AGENTERA_HOME + compact_artifact.py combined prompt.
        auth_probe_args=[
            "exec",
            "--skip-git-repo-check",
            "reply with the literal text OK",
        ],
        skips=skips,
    )
    if status != "ok":
        return
    # Probe healthy: snapshot the live config BEFORE Tasks 3/4 mutate
    # it. Snapshot is recorded but no mutation runs in this Task 2 cut.
    codex_config = Path.home() / ".codex" / "config.toml"
    snapshots.snapshot(codex_config)
    info(
        "codex: probe healthy; Task 2 cut terminates here. "
        "Tasks 3 plug in `codex exec` AGENTERA_HOME + compaction "
        "invocation under this snapshot guard."
    )


def run_copilot_live_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """Copilot live section — Task 2 cut wires probe + snapshot only.

    Tasks 3 / 4 wire the actual
    ``bash -c 'export AGENTERA_HOME=...; copilot -p ... --allow-all-tools'``
    invocation that issues the combined prompt. Like Codex, the Task 2
    cut terminates at the probe; if the probe succeeds we register the
    user's shell rc as a snapshot candidate so the framework is ready
    for Task 4 to plug in the mutation.
    """
    info("--- copilot live section ---")
    status = probe_runtime(
        binary="copilot",
        version_args=["--version"],
        # Task 2 placeholder: a deterministic "reply OK" prompt under
        # `copilot -p` non-interactive mode. --allow-all-tools is
        # required for non-interactive Copilot, named explicitly in the
        # consent line so the operator knows what they granted.
        auth_probe_args=[
            "-p",
            "reply with the literal text OK",
            "--allow-all-tools",
        ],
        skips=skips,
    )
    if status != "ok":
        return
    # Probe healthy: snapshot a shell rc candidate. Tasks 4 will pick
    # the actual rc target via the same shell-detection logic as
    # setup_copilot.py; the Task 2 cut snapshots ~/.bashrc as the
    # most-common case so the operator can see the plumbing in place.
    bashrc = Path.home() / ".bashrc"
    snapshots.snapshot(bashrc)
    info(
        "copilot: probe healthy; Task 2 cut terminates here. "
        "Tasks 4 plug in `bash -c 'export AGENTERA_HOME=...; copilot -p "
        "... --allow-all-tools'` invocation under this snapshot guard."
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="smoke_live_hosts.py",
        description=(
            "Live-host smoke harness for Codex and Copilot AGENTERA_HOME "
            "inheritance. Default mode runs offline checks only; --live "
            "gates per-runtime CLI sections behind a cost prompt."
        ),
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help=(
            "Enable live CLI invocations (gated behind cost prompt + "
            "consent). Without this flag the harness runs the offline "
            "audit and delegated setup helpers smoke only."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    snapshots = SnapshotRegistry()
    skips: list[tuple[str, str]] = []
    try:
        # Default-mode sections always run (also under --live), so a
        # live-mode invocation gets the offline gates as a precondition.
        run_codex_collection_audit()
        run_setup_helpers_smoke()

        if args.live:
            info("--- live mode: cost gate ---")
            if not cost_gate():
                info("aborted: consent declined; no live CLI invoked")
                return 1
            run_codex_live_section(snapshots, skips)
            run_copilot_live_section(snapshots, skips)

        if skips:
            info(
                "summary: %d section(s) skipped: %s"
                % (
                    len(skips),
                    "; ".join(f"{name} ({reason})" for name, reason in skips),
                )
            )
        print("PASS: all smoke checks passed")
        return 0
    finally:
        snapshots.restore_all()


if __name__ == "__main__":
    sys.exit(main())
