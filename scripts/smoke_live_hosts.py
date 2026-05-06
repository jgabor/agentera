#!/usr/bin/env -S uv run --script
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
        Runs an offline profilera corpus-collection fixture through the
        bundled extractor, then delegates to ``scripts/smoke_setup_helpers.py``
        as a subprocess so the existing helper smoke continues to gate this
        harness. No live CLI is invoked. Exits 0 with
        ``PASS: all smoke checks passed``.

    Live mode (--live)
        Probes the ``codex``, ``copilot``, and ``opencode`` binaries.
        Missing binaries, broken version probes, and auth-style failures
        become distinct SKIP outcomes; substantive live assertion failures
        fail the run. Snapshots ``~/.codex/config.toml``, Codex hooks,
        shell rc files, and OpenCode auth storage before any section that
        could touch them; restores from tmp snapshots in the top-level
        ``finally`` block on every exit path. OpenCode's live section also
        redirects config/data/cache paths to temporary XDG directories so
        session state stays off the user's real OpenCode store.

Cost gate (live mode only):
    Prints ``Estimated cost: $0.40-2.00 across four model calls`` and a
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

    uv run scripts/smoke_live_hosts.py            # default mode
    uv run scripts/smoke_live_hosts.py --live     # live mode (gated)

Exits 0 with ``PASS: all smoke checks passed`` on success (including
clean SKIPs in live mode), 1 with ``FAIL: <reason>`` on the first hard
failure (fail-fast).
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SETUP_HELPERS_SMOKE = REPO_ROOT / "scripts" / "smoke_setup_helpers.py"
AGENTERA_CLI = REPO_ROOT / "scripts" / "agentera"
AGENTERA_ARTIFACT_REGISTRY = REPO_ROOT / "scripts" / "artifact_registry.py"
AGENTERA_UPGRADE = REPO_ROOT / "scripts" / "agentera_upgrade.py"
EXTRACT_CORPUS = REPO_ROOT / "scripts" / "extract_corpus.py"

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


def _install_query_cli_bundle(install_root: Path) -> None:
    """Install the minimal files needed for `agentera query` smoke probes."""
    (install_root / "scripts").mkdir(parents=True)
    shutil.copy2(AGENTERA_CLI, install_root / "scripts" / "agentera")
    shutil.copy2(AGENTERA_ARTIFACT_REGISTRY, install_root / "scripts" / "artifact_registry.py")
    shutil.copy2(AGENTERA_UPGRADE, install_root / "scripts" / "agentera_upgrade.py")
    shutil.copytree(
        REPO_ROOT / "skills" / "agentera" / "schemas",
        install_root / "skills" / "agentera" / "schemas",
    )
    shutil.copytree(
        REPO_ROOT / "references" / "artifacts",
        install_root / "references" / "artifacts",
    )


# ---------------------------------------------------------------------------
# Snapshot / restore registry
# ---------------------------------------------------------------------------


# Tmp-backup path glob; orphan detection at startup scans this and the
# matching ``.meta`` sidecars to restore (or refuse) any leftover
# snapshots from a prior crashed run (Task 3 AC5).
SNAPSHOT_TMP_PREFIX = "/tmp/agentera-smoke-live-"
SNAPSHOT_TMP_GLOB = f"{SNAPSHOT_TMP_PREFIX}*.bak"
SNAPSHOT_META_SUFFIX = ".meta"


class SnapshotRegistry:
    """Track ``(original_path, tmp_backup_path)`` pairs for restore.

    The harness registers a snapshot via :meth:`snapshot` BEFORE any
    mutation. The top-level ``finally`` block calls :meth:`restore_all`
    which copies each tmp backup back over the original (or unlinks the
    original if the snapshot recorded an absent file). Idempotent:
    calling :meth:`snapshot` twice for the same path is a no-op so
    nested code paths stay safe.

    A sidecar ``<backup>.meta`` file is written next to every backup
    holding the absolute original path (or :data:`SNAPSHOT_ABSENT_MARKER`
    when the original did not exist at snapshot time). The sidecar is
    what :func:`recover_orphan_snapshots` uses on the next invocation to
    locate originals when a prior run crashed before its ``finally``
    block restored them.
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
            f"{SNAPSHOT_TMP_PREFIX}{path.name}-{ts}-{id(path):x}.bak"
        )
        shutil.copy2(path, backup)
        # Write the sidecar BEFORE recording the entry so an orphan
        # detector on a future run sees a complete pair even if the
        # process is killed between the copy and the dict insert.
        meta = backup.with_suffix(backup.suffix + SNAPSHOT_META_SUFFIX)
        meta.write_text(str(path.resolve()) + "\n", encoding="utf-8")
        self._entries[key] = (path, backup)
        info(f"snapshot: {path} -> {backup}")
        return backup

    def restore_all(self) -> None:
        """Restore every snapshotted path. Safe to call from ``finally``.

        Errors during restore are printed but do not propagate; the
        harness already considers the run over by the time this runs,
        and partial restore beats no restore. The list of restored
        paths is printed for operator audit. The sidecar ``.meta`` file
        is unlinked alongside the backup so the orphan detector on the
        next run sees a clean tmp surface.
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
            # Clean up backup + sidecar so the next run sees no orphans.
            for cleanup in (backup, backup.with_suffix(backup.suffix + SNAPSHOT_META_SUFFIX) if backup else None):
                if cleanup is None:
                    continue
                try:
                    if cleanup.exists():
                        cleanup.unlink()
                except OSError as exc:  # pragma: no cover - best-effort
                    info(f"cleanup-error: {cleanup}: {exc}")


def recover_orphan_snapshots() -> None:
    """Detect and restore any orphan snapshots from a prior crashed run.

    Scans :data:`SNAPSHOT_TMP_GLOB` for backup files left behind by an
    earlier invocation that did not reach its ``finally`` block. For
    each backup with a sidecar ``.meta`` file, restores the original by
    copying the backup over the path the sidecar names (or, if the
    sidecar marks the original as absent at snapshot time, leaves the
    current state alone), then unlinks both the backup and the sidecar.

    Per Task 3 AC5: on next invocation the previous run's tmpfile
    snapshot is detected and restored automatically. Backups without a
    matching sidecar are reported (we cannot safely restore without
    knowing the original path) but do not block startup; the operator
    must clean those up manually.
    """
    candidates = sorted(glob.glob(SNAPSHOT_TMP_GLOB))
    if not candidates:
        return
    info(
        f"orphan-snapshots: detected {len(candidates)} tmp backup(s) from a "
        f"prior run; attempting auto-restore"
    )
    for backup_str in candidates:
        backup = Path(backup_str)
        meta = backup.with_suffix(backup.suffix + SNAPSHOT_META_SUFFIX)
        if not meta.exists():
            info(
                f"orphan-snapshots: {backup} has no sidecar .meta; cannot "
                f"identify original; leaving in place for manual cleanup"
            )
            continue
        try:
            original_str = meta.read_text(encoding="utf-8").strip()
        except OSError as exc:
            info(f"orphan-snapshots: cannot read {meta}: {exc}; skipping")
            continue
        original = Path(original_str)
        try:
            shutil.copy2(backup, original)
            info(
                f"orphan-snapshots: restored {original} from {backup} "
                f"(crashed prior run)"
            )
        except OSError as exc:
            info(
                f"orphan-snapshots: failed to restore {original} from "
                f"{backup}: {exc}"
            )
            continue
        for cleanup in (backup, meta):
            try:
                cleanup.unlink()
            except OSError as exc:
                info(f"orphan-snapshots: failed to unlink {cleanup}: {exc}")


def _sha256(path: Path) -> str:
    """Return the hex SHA256 of ``path`` (empty string if path is absent)."""
    if not path.exists():
        return "<absent>"
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Default-mode sections
# ---------------------------------------------------------------------------


def run_codex_collection_audit() -> None:
    """Prove the bundled corpus extractor can collect Codex-shaped turns."""
    info("--- profilera Codex collection audit ---")
    if not EXTRACT_CORPUS.exists():
        fail(f"profilera corpus extractor missing: {EXTRACT_CORPUS}")
    with tempfile.TemporaryDirectory(prefix="agentera-corpus-smoke-") as tmp_str:
        tmp = Path(tmp_str)
        project_root = tmp / "project"
        sessions_dir = tmp / "codex" / "sessions"
        session_path = sessions_dir / "2026" / "05" / "05" / "session.jsonl"
        output = tmp / "corpus.json"

        project_root.mkdir(parents=True)
        session_path.parent.mkdir(parents=True)
        (project_root / "AGENTS.md").write_text(
            "Prefer evidence-first execution.\n",
            encoding="utf-8",
        )
        (project_root / "package.json").write_text(
            json.dumps({"name": "agentera-smoke", "scripts": {"test": "pytest"}}),
            encoding="utf-8",
        )
        session_events = [
            {
                "type": "session_meta",
                "payload": {"id": "smoke-session", "cwd": str(project_root)},
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Should we keep flags explicit?"}],
                    "timestamp": "2026-05-05T10:00:00Z",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Yes. Explicit flags stay authoritative."}],
                    "timestamp": "2026-05-05T10:01:00Z",
                },
            },
        ]
        session_path.write_text(
            "\n".join(json.dumps(event) for event in session_events) + "\n",
            encoding="utf-8",
        )

        result = subprocess.run(
            [
                sys.executable,
                str(EXTRACT_CORPUS),
                "--output",
                str(output),
                "--project-root",
                str(project_root),
                "--codex-sessions-dir",
                str(sessions_dir),
                "--no-claude",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.stdout:
            for line in result.stdout.rstrip("\n").splitlines():
                info(f"  {line}")
        if result.stderr:
            for line in result.stderr.rstrip("\n").splitlines():
                info(f"  stderr: {line}")
        assert_true(result.returncode == 0, "profilera corpus extractor failed")
        assert_true(output.exists(), "profilera corpus extractor did not write corpus.json")
        corpus = json.loads(output.read_text(encoding="utf-8"))
        families = corpus.get("metadata", {}).get("families", {})
        assert_true(
            families.get("conversation_turn", {}).get("count") == 2,
            "profilera corpus extractor did not collect Codex conversation turns",
        )
        assert_true(
            families.get("history_prompt", {}).get("count") == 1,
            "profilera corpus extractor did not classify decision-rich user prompts",
        )
        assert_true(
            families.get("instruction_document", {}).get("count") == 1,
            "profilera corpus extractor did not collect instruction documents",
        )
        assert_true(
            families.get("project_config_signal", {}).get("count") == 1,
            "profilera corpus extractor did not collect project config signals",
        )
    info("PASS: profilera Codex collection audit")


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
    "Estimated cost: $0.40-2.00 across four model calls "
    "(codex exec AGENTERA_HOME + query probe, codex exec "
    "apply_patch hook firing probe, copilot -p AGENTERA_HOME + "
    "query probe, opencode run AGENTERA_HOME + query probe; "
    "--live mode only)"
)
CONSENT_LINE = (
    "Proceed with live CLI invocations (codex exec x2 + copilot -p "
    "--allow-all-tools + opencode run --pure)? [y/N]: "
)


CONSENT_ENV_VAR = "AGENTERA_LIVE_CONSENT"


def cost_gate(auto_consent: bool = False) -> bool:
    """Print the cost line and a one-line consent prompt.

    Returns ``True`` on ``y`` / ``yes`` (case-insensitive), ``False``
    otherwise. The harness aborts cleanly on a non-affirmative response
    so the operator can dry-probe the harness UX without spending any
    model budget. ``--allow-all-tools`` is named in the consent line
    per Task 4 AC3 so the operator knows what permission they grant.

    Bypass paths (T6):
        ``auto_consent=True`` (set by ``--yes``) or
        ``$AGENTERA_LIVE_CONSENT=1`` short-circuits the interactive
        prompt and logs an explicit ``auto-consented via flag`` audit
        line so realisera/orkestrera dispatch can drive the harness
        non-interactively without altering the cost-visibility contract
        (the cost line still prints).
    """
    print(COST_LINE)
    env_consent = os.environ.get(CONSENT_ENV_VAR, "").strip() == "1"
    if auto_consent or env_consent:
        source = "--yes flag" if auto_consent else f"${CONSENT_ENV_VAR}=1"
        info(f"consent: auto-consented via flag ({source}); skipping prompt")
        return True
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


# Wall-clock cap for the substantive `codex exec` invocation. Comfortably
# above any normal model latency for a two-step bash-tool prompt; below
# the 10-minute Bash tool ceiling so a hung run cannot strand the harness.
CODEX_EXEC_TIMEOUT_SECONDS = 300


def run_codex_live_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """Codex live section — exactly one ``codex exec`` invocation per Task 3.

    Sequence:

    1. PATH probe (``shutil.which("codex")``); skip ``not-on-path`` on
       miss without invoking the binary.
    2. ``codex --version`` sanity probe; skip ``not-authed`` on
       non-zero / timeout (covers a half-broken install).
    3. Snapshot ``~/.codex/config.toml`` and SHA256-hash it BEFORE any
       mutation. The harness never writes to the real config (we set
       ``CODEX_HOME`` to a tmp dir for the actual ``codex exec`` call),
       but the snapshot + hash are kept as defense-in-depth so a regression
       in this section that accidentally targeted the real path would be
       caught at the post-run hash comparison (AC4).
    4. Build a tmp ``CODEX_HOME`` directory: copy the user's auth.json
       (so codex is authenticated) and run ``setup_codex.py
       --config-file <tmp>/config.toml --install-root <repo>`` so the
       tmp config carries ``[shell_environment_policy].set.AGENTERA_HOME``
       pointing at the real install root.
    5. Use a tmp workdir for the non-interactive ``codex exec`` run.
    6. Issue exactly ONE ``codex exec`` invocation with a combined prompt
       asking the agent to (a) print AGENTERA_HOME from a bash tool call
       and (b) run ``agentera query --list-artifacts`` via
       ``$AGENTERA_HOME/scripts/agentera``. The tmp
       ``CODEX_HOME`` is exported via the env so codex picks up the tmp
       config; ``--cd <tmp_workdir> --skip-git-repo-check
       --dangerously-bypass-approvals-and-sandbox -s danger-full-access``
       lets the bash tool calls actually run without an approval round-trip.
    7. Parse stdout for the AGENTERA_HOME echo (must equal the install
       root) and assert the query output includes core artifact names.
    8. SHA256 the real ``~/.codex/config.toml`` AFTER and assert
       byte-identity vs the BEFORE hash (AC4).

    On any failure step, raise via :func:`fail` (the top-level
    ``finally`` still restores the snapshot). The skip path covers only
    the "binary missing or unauthenticated" cases per AC; substantive
    failures are hard fails by design (the user authorized live spend
    and expects assertive verification).
    """
    info("--- codex live section ---")

    # Step 1: PATH probe. Quick skip without invoking anything.
    if shutil.which("codex") is None:
        skip("codex", "not on PATH", skips)
        return
    info(f"probe: codex resolved to {shutil.which('codex')}")

    # Step 2: --version sanity. Treat failure as not-authed (binary is
    # present but uncooperative).
    try:
        version_result = subprocess.run(
            ["codex", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip("codex", "binary present but `codex --version` timed out", skips)
        return
    if version_result.returncode != 0:
        skip(
            "codex",
            f"binary present but `codex --version` exited "
            f"{version_result.returncode}",
            skips,
        )
        return
    info(f"probe: codex {version_result.stdout.strip()}")

    # Step 3: snapshot + SHA256 the real config BEFORE any mutation.
    real_codex_config = Path.home() / ".codex" / "config.toml"
    snapshots.snapshot(real_codex_config)
    sha_before = _sha256(real_codex_config)
    info(f"codex-config sha256 (before): {sha_before}")

    # Step 4: build a tmp CODEX_HOME dir and write the tmp config via
    # setup_codex.py --config-file. The user's real ~/.codex is untouched.
    install_root = REPO_ROOT
    setup_codex_py = REPO_ROOT / "scripts" / "setup_codex.py"
    if not setup_codex_py.exists():
        fail(f"setup_codex.py missing at {setup_codex_py}")

    with tempfile.TemporaryDirectory(
        prefix="agentera-smoke-codex-home-"
    ) as tmp_codex_home_str:
        tmp_codex_home = Path(tmp_codex_home_str)
        info(f"codex: tmp CODEX_HOME={tmp_codex_home}")

        # Mirror real auth.json into the tmp dir so codex is authenticated.
        # Without this, the only-config-isolated tmp dir would have no
        # auth and codex exec would fail with auth-required noise.
        real_auth = Path.home() / ".codex" / "auth.json"
        if real_auth.exists():
            shutil.copy2(real_auth, tmp_codex_home / "auth.json")
            info(f"codex: copied auth.json into tmp CODEX_HOME (authed)")
        else:
            skip(
                "codex",
                "no ~/.codex/auth.json on host; cannot run authed codex exec",
                skips,
            )
            # Hash assertion still runs in finally; restore_all in main
            # will revert the snapshot, so we just exit the section.
            sha_after = _sha256(real_codex_config)
            info(f"codex-config sha256 (after): {sha_after}")
            assert_true(
                sha_before == sha_after,
                f"codex-config SHA256 changed: before={sha_before} "
                f"after={sha_after}",
            )
            return

        # Run setup_codex.py against the tmp config. This writes
        # [shell_environment_policy].set.AGENTERA_HOME = <install_root>.
        tmp_config = tmp_codex_home / "config.toml"
        setup_result = subprocess.run(
            [
                sys.executable,
                str(setup_codex_py),
                "--config-file",
                str(tmp_config),
                "--install-root",
                str(install_root),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if setup_result.returncode != 0:
            fail(
                f"setup_codex.py --config-file failed exit "
                f"{setup_result.returncode}: stdout={setup_result.stdout!r} "
                f"stderr={setup_result.stderr!r}"
            )
        info(f"codex: setup_codex.py wrote {tmp_config}: {setup_result.stdout.strip()}")
        # Sanity-check the tmp config contains AGENTERA_HOME.
        tmp_config_text = tmp_config.read_text(encoding="utf-8")
        assert_true(
            f'AGENTERA_HOME = "{install_root}"' in tmp_config_text,
            f"tmp config missing AGENTERA_HOME entry. content:\n{tmp_config_text}",
        )

        with tempfile.TemporaryDirectory(
            prefix="agentera-smoke-codex-query-"
        ) as tmp_workdir_str:
            tmp_workdir = Path(tmp_workdir_str)
            info(f"codex: tmp workdir={tmp_workdir}")

            # Step 6: build the combined prompt. The agent is asked to do
            # exactly two bash tool calls in sequence and report both
            # observations between markers we can grep for. Markers are
            # used (not raw values) so the parser can extract the
            # AGENTERA_HOME value verbatim regardless of surrounding prose.
            prompt = (
                "Run exactly these two bash commands (in order) using your "
                "shell tool. After running them, print the markers below "
                "with the captured outputs filled in.\n\n"
                "Command 1: echo \"AGENTERA_HOME=$AGENTERA_HOME\"\n"
                "Command 2: uv run \"$AGENTERA_HOME/scripts/agentera\" "
                "query --list-artifacts\n\n"
                "Then print this block as your final message, replacing "
                "<value1> and <value2> with the literal stdout you observed:\n\n"
                "===AGENTERA_HOME_ECHO_BEGIN===\n"
                "<value1>\n"
                "===AGENTERA_HOME_ECHO_END===\n"
                "===QUERY_OUTPUT_BEGIN===\n"
                "<value2>\n"
                "===QUERY_OUTPUT_END==="
            )

            # Step 6 (cont.): exactly one codex exec invocation. CODEX_HOME
            # points at our tmp dir so codex reads the tmp config (which
            # carries AGENTERA_HOME via shell_environment_policy.set).
            # --dangerously-bypass-approvals-and-sandbox + danger-full-access
            # is required for the bash tool to actually run uv against
            # the query CLI without an approval round-trip; this is the
            # documented non-interactive path. The user pre-authorized live
            # spend.
            env = dict(os.environ)
            env["CODEX_HOME"] = str(tmp_codex_home)

            output_last = tmp_workdir / "codex-last-message.txt"
            cmd = [
                "codex",
                "exec",
                "--cd",
                str(tmp_workdir),
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--output-last-message",
                str(output_last),
                prompt,
            ]
            info(f"codex: invoking `codex exec` (CODEX_HOME={tmp_codex_home})")
            t0 = time.time()
            try:
                exec_result = subprocess.run(
                    cmd,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=CODEX_EXEC_TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                fail(
                    f"`codex exec` timed out at {CODEX_EXEC_TIMEOUT_SECONDS}s "
                    f"(partial stdout={exc.stdout!r})"
                )
                return  # unreachable; satisfies type checker
            elapsed = time.time() - t0
            info(f"codex: `codex exec` returned exit={exec_result.returncode} in {elapsed:.1f}s")

            if exec_result.returncode != 0:
                # Treat exec failure as either auth issue (skip) or hard
                # fail. Authentication-style failures usually mention auth
                # in stderr; conservative default is hard-fail with the
                # full output so the operator can diagnose.
                stderr_lower = exec_result.stderr.lower()
                if "auth" in stderr_lower or "login" in stderr_lower:
                    skip(
                        "codex",
                        f"`codex exec` returned auth-style failure "
                        f"(exit {exec_result.returncode}); see stderr",
                        skips,
                    )
                    info(f"codex: stdout={exec_result.stdout!r}")
                    info(f"codex: stderr={exec_result.stderr!r}")
                    sha_after = _sha256(real_codex_config)
                    info(f"codex-config sha256 (after): {sha_after}")
                    assert_true(
                        sha_before == sha_after,
                        f"codex-config SHA256 changed: before={sha_before} "
                        f"after={sha_after}",
                    )
                    return
                fail(
                    f"`codex exec` exit {exec_result.returncode}: "
                    f"stdout={exec_result.stdout!r} stderr={exec_result.stderr!r}"
                )

            # Capture the agent output. Prefer the --output-last-message
            # file (deterministic, only the final agent message), fall
            # back to stdout if for some reason the file is empty.
            agent_output = ""
            if output_last.exists():
                agent_output = output_last.read_text(encoding="utf-8")
            if not agent_output.strip():
                agent_output = exec_result.stdout
            info("codex: --- captured agent output begin ---")
            for line in agent_output.rstrip("\n").splitlines():
                info(f"  {line}")
            info("codex: --- captured agent output end ---")

            # Step 7a: parse the AGENTERA_HOME echo between markers.
            ah_value = _extract_between(
                agent_output,
                "===AGENTERA_HOME_ECHO_BEGIN===",
                "===AGENTERA_HOME_ECHO_END===",
            )
            assert_true(
                ah_value is not None,
                "codex: could not find AGENTERA_HOME echo markers in output",
            )
            assert ah_value is not None  # for type checker
            ah_value = ah_value.strip()
            # The value carries the `AGENTERA_HOME=<path>` form from echo.
            expected_marker = f"AGENTERA_HOME={install_root}"
            assert_true(
                expected_marker in ah_value,
                f"codex: AGENTERA_HOME echo {ah_value!r} does not contain "
                f"expected {expected_marker!r}",
            )
            info(f"codex: AGENTERA_HOME echo verified: {ah_value}")

            # Step 7b: assert the query CLI resolved through AGENTERA_HOME.
            query_output = _extract_between(
                agent_output,
                "===QUERY_OUTPUT_BEGIN===",
                "===QUERY_OUTPUT_END===",
            )
            assert_true(
                query_output is not None,
                "codex: could not find query output markers in output",
            )
            assert query_output is not None
            missing = [
                artifact
                for artifact in ("decisions", "progress", "session")
                if artifact not in query_output.split()
            ]
            assert_true(
                not missing,
                f"codex: query output missing expected artifact names: {missing}; "
                f"output={query_output!r}",
            )
            info(f"codex: query output verified: {query_output.strip()}")

    # Step 8: post-run SHA256 check on the real config (defense-in-depth).
    sha_after = _sha256(real_codex_config)
    info(f"codex-config sha256 (after): {sha_after}")
    assert_true(
        sha_before == sha_after,
        f"codex-config SHA256 changed during harness run: "
        f"before={sha_before} after={sha_after}",
    )

    # AC3: explicit scope statement in the output.
    info(
        "codex: verified under codex exec; interactive mode inferred via "
        "shell_environment_policy semantics"
    )


# Wall-clock cap for the apply_patch hook-firing `codex exec` invocation.
# Mirrors CODEX_EXEC_TIMEOUT_SECONDS: comfortably above any normal model
# latency for a one-step apply_patch prompt; below the 10-minute Bash tool
# ceiling so a hung run cannot strand the harness.
CODEX_HOOK_EXEC_TIMEOUT_SECONDS = 300


# Codex hook config relative path inside CODEX_HOME (per `codex-rs/hooks/
# src/engine/discovery.rs::load_hooks_json`: `$CODEX_HOME/hooks.json`
# is the user-layer discovery path; with CODEX_HOME pointed at a tmp dir,
# Codex reads our wrapper config without ever touching `~/.codex/hooks.json`).
CODEX_HOOKS_FILENAME = "hooks.json"


def run_codex_hook_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """Codex apply_patch hook section — exactly one ``codex exec`` per Task 6.

    Verifies the T3 (Cycle 191) ``hooks/codex-hooks.json`` wiring fires
    end-to-end on a live Codex invocation: PreToolUse + PostToolUse
    matchers on ``apply_patch`` shell out to ``validate_artifact.py``
    when the agent edits a file via the apply_patch tool.

    Sequence:

    1. PATH probe (``shutil.which("codex")``); skip ``not-on-path`` on
       miss without invoking the binary. Same shape as Task 3 section.
    2. Hook-config-absent gate: if ``hooks/codex-hooks.json`` is missing
       from the install root, SKIP with a distinct ``hook config absent``
       reason so this case is visibly different from ``hook didn't fire``
       and ``hook fired but returned non-zero``.
    3. Snapshot ``~/.codex/hooks.json`` and SHA256-hash it BEFORE any
       mutation. Defense-in-depth (the harness sets ``CODEX_HOME`` to a
       tmp dir so Codex never reads the real ``~/.codex/hooks.json``);
       the post-run round-trip catches any regression that accidentally
       targeted the real path.
    4. Build a tmp ``CODEX_HOME`` directory; copy the user's
       ``auth.json`` so codex is authenticated; write a wrapper hooks
       config that records every hook firing to a sentinel file AND
       invokes the real ``hooks/validate_artifact.py``. The wrapper's
       exit code is the real hook's exit code, so the wiring is
       byte-faithful to T3 plus we get observable evidence on disk.
    5. Issue exactly ONE ``codex exec`` invocation in a tmp workdir with
       a prompt asking the agent to create a one-line file via the
       apply_patch tool. ``CODEX_HOME`` exports the tmp config; the same
       ``--dangerously-bypass-approvals-and-sandbox`` flag the Task 3
       section uses lets apply_patch run without an approval round-trip.
    6. Distinct PASS/FAIL/SKIP per AC3:

       - ``hook config absent`` (step 2 already returned): SKIP
       - ``codex exec`` returned auth failure: SKIP (no Codex auth)
       - sentinel file does not exist: FAIL ``hook didn't fire``
       - sentinel records non-zero hook exit: FAIL
         ``hook fired but returned non-zero``
       - sentinel records both Pre+Post entries with exit 0: PASS

    7. SHA256 the real ``~/.codex/hooks.json`` AFTER and assert
       byte-identity vs the BEFORE hash (defense-in-depth, mirrors the
       Task 3 SHA256 round-trip on ``~/.codex/config.toml``).

    On substantive failures, raise via :func:`fail` (the top-level
    ``finally`` still restores snapshots). The skip path covers the AC3
    ``hook config absent`` and Codex-auth-missing cases; substantive
    failures are hard fails by design (the user authorized live spend
    and expects assertive verification).

    Pre-authorized live model spend bounded at one ``codex exec`` per
    runtime per AC3; this is the second ``codex exec`` invocation in the
    live path (Task 3 section issued the first). Cost is captured from
    the agent output on stdout and surfaced for operator audit.
    """
    info("--- codex apply_patch hook section ---")

    # Step 1: PATH probe.
    if shutil.which("codex") is None:
        skip("codex-hook", "not on PATH", skips)
        return
    info(f"probe: codex resolved to {shutil.which('codex')}")

    # Step 2: hook-config-absent gate. Distinct skip per AC3.
    real_hook_config = REPO_ROOT / "hooks" / "codex-hooks.json"
    if not real_hook_config.exists():
        skip(
            "codex-hook",
            f"hook config absent ({real_hook_config} not found; "
            f"T3 wiring not present in this checkout)",
            skips,
        )
        return
    info(f"codex-hook: hook config present at {real_hook_config}")

    # Step 3: snapshot + SHA256 the real ~/.codex/hooks.json BEFORE
    # any mutation. The harness writes hooks.json into CODEX_HOME=<tmp>,
    # never to the real ~/.codex, but the snapshot + hash defends against
    # a regression that accidentally targeted the real path.
    real_codex_hooks = Path.home() / ".codex" / "hooks.json"
    snapshots.snapshot(real_codex_hooks)
    sha_before = _sha256(real_codex_hooks)
    info(f"codex-hook: ~/.codex/hooks.json sha256 (before): {sha_before}")

    install_root = REPO_ROOT
    validate_artifact_py = REPO_ROOT / "hooks" / "validate_artifact.py"
    if not validate_artifact_py.exists():
        fail(f"codex-hook: validate_artifact.py missing at {validate_artifact_py}")

    with tempfile.TemporaryDirectory(
        prefix="agentera-smoke-codex-hook-home-"
    ) as tmp_codex_home_str:
        tmp_codex_home = Path(tmp_codex_home_str)
        info(f"codex-hook: tmp CODEX_HOME={tmp_codex_home}")

        # Mirror real auth.json into the tmp dir so codex is authenticated.
        real_auth = Path.home() / ".codex" / "auth.json"
        if real_auth.exists():
            shutil.copy2(real_auth, tmp_codex_home / "auth.json")
            info("codex-hook: copied auth.json into tmp CODEX_HOME (authed)")
        else:
            skip(
                "codex-hook",
                "no ~/.codex/auth.json on host; cannot run authed codex exec",
                skips,
            )
            sha_after = _sha256(real_codex_hooks)
            info(f"codex-hook: ~/.codex/hooks.json sha256 (after): {sha_after}")
            assert_true(
                sha_before == sha_after,
                f"codex-hook: ~/.codex/hooks.json SHA256 changed: "
                f"before={sha_before} after={sha_after}",
            )
            return

        # Step 4: write the sentinel-recording wrapper hook config. The
        # wrapper script appends a one-line trace to <sentinel> on every
        # firing, then execs the real validate_artifact.py with the same
        # stdin so the wiring is byte-faithful to T3. Hook exit code is
        # the wrapper's exit code (== validate_artifact.py exit code).
        sentinel_path = tmp_codex_home / "hook-fired.log"
        wrapper_script = tmp_codex_home / "hook_wrapper.py"
        wrapper_script.write_text(
            "#!/usr/bin/env -S uv run --script\n"
            "# /// script\n"
            "# requires-python = \">=3.11\"\n"
            "# dependencies = []\n"
            "# ///\n"
            "# Sentinel-recording wrapper for the agentera Codex apply_patch hook.\n"
            "# Reads the Codex hook stdin once, appends a one-line trace to the\n"
            "# sentinel path, then re-feeds stdin to validate_artifact.py and\n"
            "# exits with that script's exit code so the wiring is byte-faithful.\n"
            "import json\n"
            "import os\n"
            "import subprocess\n"
            "import sys\n"
            "\n"
            f"SENTINEL = {str(sentinel_path)!r}\n"
            f"VALIDATE = {str(validate_artifact_py)!r}\n"
            "\n"
            "raw = sys.stdin.read()\n"
            "event = '<unknown>'\n"
            "tool = '<unknown>'\n"
            "try:\n"
            "    parsed = json.loads(raw) if raw.strip() else {}\n"
            "    event = parsed.get('hook_event_name', '<unknown>')\n"
            "    tool = parsed.get('tool_name', '<unknown>')\n"
            "except (json.JSONDecodeError, AttributeError):\n"
            "    pass\n"
            "\n"
            "# Run the real validate_artifact.py with the same stdin.\n"
            "result = subprocess.run(\n"
            "    ['uv', 'run', VALIDATE],\n"
            "    input=raw,\n"
            "    capture_output=True,\n"
            "    text=True,\n"
            ")\n"
            "\n"
            "# Append sentinel trace BEFORE re-emitting stdout/stderr so a\n"
            "# crash inside the validator still leaves an observable trace.\n"
            "with open(SENTINEL, 'a', encoding='utf-8') as fh:\n"
            "    fh.write(\n"
            "        f'event={event} tool={tool} '\n"
            "        f'exit={result.returncode} '\n"
            "        f'stdout_len={len(result.stdout)} '\n"
            "        f'stderr_len={len(result.stderr)}\\n'\n"
            "    )\n"
            "\n"
            "if result.stdout:\n"
            "    sys.stdout.write(result.stdout)\n"
            "if result.stderr:\n"
            "    sys.stderr.write(result.stderr)\n"
            "sys.exit(result.returncode)\n",
            encoding="utf-8",
        )
        os.chmod(wrapper_script, 0o755)

        # Codex hook config that points PreToolUse + PostToolUse
        # apply_patch matchers at the wrapper. AGENTERA_HOME is exported
        # so the real validate_artifact.py inside the wrapper resolves
        # the install root the way it does in production. Quoting the
        # command path defends against any future install root that
        # contains spaces.
        tmp_hooks_config = tmp_codex_home / CODEX_HOOKS_FILENAME
        hook_command = f'uv run "{wrapper_script}"'
        tmp_hooks_config.write_text(
            json.dumps(
                {
                    "description": (
                        "agentera Codex hook smoke wrapper: records every "
                        "apply_patch hook firing to a sentinel file then "
                        "delegates to the real validate_artifact.py"
                    ),
                    "hooks": {
                        "PreToolUse": [
                            {
                                "matcher": "^apply_patch$",
                                "hooks": [
                                    {
                                        "type": "command",
                                        "command": hook_command,
                                        "timeout": 10,
                                        "statusMessage": "validating artifact (smoke)",
                                    }
                                ],
                            }
                        ],
                        "PostToolUse": [
                            {
                                "matcher": "^apply_patch$",
                                "hooks": [
                                    {
                                        "type": "command",
                                        "command": hook_command,
                                        "timeout": 10,
                                        "statusMessage": "validating artifact (smoke)",
                                    }
                                ],
                            }
                        ],
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        info(f"codex-hook: wrote tmp hooks.json to {tmp_hooks_config}")

        # Step 5: spawn an apply_patch via codex exec. The prompt names
        # exactly one tiny file edit so the agent uses apply_patch
        # without scope creep; tmp workdir keeps the touched file off
        # the real tree. cwd is set so the validator inside the wrapper
        # gets a consistent project_root.
        with tempfile.TemporaryDirectory(
            prefix="agentera-smoke-codex-hook-workdir-"
        ) as tmp_workdir_str:
            tmp_workdir = Path(tmp_workdir_str)
            target_file = tmp_workdir / "hook_probe.txt"
            prompt = (
                "Use the apply_patch tool to create a NEW file at "
                f"{target_file} with EXACTLY one line of content: "
                "'agentera hook probe' (no quotes, no trailing newline "
                "metadata). After the apply_patch completes, print the "
                "literal text DONE on its own line and end your turn."
            )

            env = dict(os.environ)
            env["CODEX_HOME"] = str(tmp_codex_home)
            env["AGENTERA_HOME"] = str(install_root)

            output_last = tmp_workdir / "codex-hook-last-message.txt"
            # Mirror run_codex_live_section: do NOT pin --model so Codex
            # picks the account-default model. ChatGPT-account auth
            # rejects `gpt-5-codex` even though it is the documented
            # default for API-key auth; letting Codex resolve the model
            # keeps the section working under both auth modes.
            cmd = [
                "codex",
                "exec",
                "--cd",
                str(tmp_workdir),
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--output-last-message",
                str(output_last),
                prompt,
            ]
            info(
                f"codex-hook: invoking `codex exec` "
                f"(CODEX_HOME={tmp_codex_home}; model resolves from account default)"
            )
            t0 = time.time()
            try:
                exec_result = subprocess.run(
                    cmd,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=CODEX_HOOK_EXEC_TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                fail(
                    f"codex-hook: `codex exec` timed out at "
                    f"{CODEX_HOOK_EXEC_TIMEOUT_SECONDS}s "
                    f"(partial stdout={exc.stdout!r})"
                )
                return  # unreachable; satisfies type checker
            elapsed = time.time() - t0
            info(
                f"codex-hook: `codex exec` returned "
                f"exit={exec_result.returncode} in {elapsed:.1f}s"
            )

            if exec_result.returncode != 0:
                stderr_lower = exec_result.stderr.lower()
                if "auth" in stderr_lower or "login" in stderr_lower:
                    skip(
                        "codex-hook",
                        f"`codex exec` returned auth-style failure "
                        f"(exit {exec_result.returncode}); see stderr",
                        skips,
                    )
                    info(f"codex-hook: stdout={exec_result.stdout!r}")
                    info(f"codex-hook: stderr={exec_result.stderr!r}")
                    sha_after = _sha256(real_codex_hooks)
                    info(
                        f"codex-hook: ~/.codex/hooks.json sha256 (after): "
                        f"{sha_after}"
                    )
                    assert_true(
                        sha_before == sha_after,
                        f"codex-hook: ~/.codex/hooks.json SHA256 changed: "
                        f"before={sha_before} after={sha_after}",
                    )
                    return
                fail(
                    f"codex-hook: `codex exec` exit {exec_result.returncode}: "
                    f"stdout={exec_result.stdout!r} "
                    f"stderr={exec_result.stderr!r}"
                )

            # Step 6: distinct PASS/FAIL outcomes per AC3.
            agent_output = ""
            if output_last.exists():
                agent_output = output_last.read_text(encoding="utf-8")
            if not agent_output.strip():
                agent_output = exec_result.stdout
            info("codex-hook: --- captured agent output begin ---")
            for line in agent_output.rstrip("\n").splitlines():
                info(f"  {line}")
            info("codex-hook: --- captured agent output end ---")

            # Surface the cost summary line Codex prints at the end of
            # `codex exec` so the operator can pin actual live spend.
            cost_lines = [
                line
                for line in exec_result.stdout.splitlines()
                if "tokens" in line.lower() or "cost" in line.lower()
            ]
            for line in cost_lines:
                info(f"codex-hook: cost summary: {line.strip()}")

            # Verify the agent actually used apply_patch by checking the
            # target file landed. If not, the prompt was misinterpreted
            # and the hook had nothing to fire on; surface that distinctly.
            if not target_file.exists():
                fail(
                    f"codex-hook: target file {target_file} not created; "
                    f"agent likely did not invoke apply_patch (no hook to fire)"
                )
            info(
                f"codex-hook: target file created at {target_file} "
                f"(size={target_file.stat().st_size} bytes)"
            )

            # AC3 distinct outcomes: hook didn't fire vs hook fired but
            # returned non-zero vs hook fired clean.
            if not sentinel_path.exists():
                fail(
                    f"codex-hook: hook didn't fire (sentinel "
                    f"{sentinel_path} not created); apply_patch ran but "
                    f"PreToolUse + PostToolUse handlers did not execute. "
                    f"Likely causes: hooks.json discovery path mismatch, "
                    f"matcher regex did not match tool_name, or Codex hook "
                    f"feature disabled in this build"
                )

            sentinel_text = sentinel_path.read_text(encoding="utf-8")
            sentinel_lines = [
                line for line in sentinel_text.splitlines() if line.strip()
            ]
            info(
                f"codex-hook: sentinel recorded "
                f"{len(sentinel_lines)} hook firing(s)"
            )
            for line in sentinel_lines:
                info(f"  sentinel: {line}")

            # Parse each sentinel line into key=value pairs for assertions.
            firings: list[dict[str, str]] = []
            for line in sentinel_lines:
                fields: dict[str, str] = {}
                for token in line.split():
                    if "=" in token:
                        k, _, v = token.partition("=")
                        fields[k] = v
                firings.append(fields)

            non_zero = [f for f in firings if f.get("exit", "0") != "0"]
            if non_zero:
                fail(
                    f"codex-hook: hook fired but returned non-zero on "
                    f"{len(non_zero)}/{len(firings)} firing(s); "
                    f"first failing entry: {non_zero[0]}"
                )

            events_seen = {f.get("event", "<unknown>") for f in firings}
            tools_seen = {f.get("tool", "<unknown>") for f in firings}
            assert_true(
                "apply_patch" in tools_seen,
                f"codex-hook: no apply_patch firing recorded "
                f"(tools seen: {sorted(tools_seen)})",
            )
            # Expect both PreToolUse and PostToolUse per the T3 wiring.
            # Surface as a warning rather than fail if only one fired:
            # Codex MAY skip PreToolUse for synthetic patches in some
            # bypass-sandbox modes; PostToolUse alone still proves the
            # wiring works. AC2 says PreToolUse and/or PostToolUse.
            if "PreToolUse" not in events_seen:
                info(
                    "codex-hook: PreToolUse not observed in sentinel; "
                    "PostToolUse alone satisfies AC2 (PreToolUse and/or "
                    "PostToolUse) but flagging for operator audit"
                )
            if "PostToolUse" not in events_seen:
                info(
                    "codex-hook: PostToolUse not observed in sentinel; "
                    "PreToolUse alone satisfies AC2 (PreToolUse and/or "
                    "PostToolUse) but flagging for operator audit"
                )
            assert_true(
                bool(events_seen & {"PreToolUse", "PostToolUse"}),
                f"codex-hook: neither PreToolUse nor PostToolUse fired "
                f"(events seen: {sorted(events_seen)})",
            )
            info(
                f"codex-hook: PASS — apply_patch hook fired clean "
                f"(events={sorted(events_seen)}, exits=0/0, "
                f"firings={len(firings)})"
            )

    # Step 7: post-run SHA256 round-trip on the real ~/.codex/hooks.json.
    sha_after = _sha256(real_codex_hooks)
    info(f"codex-hook: ~/.codex/hooks.json sha256 (after): {sha_after}")
    assert_true(
        sha_before == sha_after,
        f"codex-hook: ~/.codex/hooks.json SHA256 changed during run: "
        f"before={sha_before} after={sha_after}",
    )


def _extract_between(text: str, begin: str, end: str) -> str | None:
    """Return the substring strictly between ``begin`` and ``end`` markers.

    Returns ``None`` if either marker is absent or end precedes begin.
    Used to pull the AGENTERA_HOME echo and query stdout out of the
    agent's final-message text without depending on regex backslashes
    interacting with the marker strings.
    """
    bi = text.find(begin)
    if bi < 0:
        return None
    bi_end = bi + len(begin)
    ei = text.find(end, bi_end)
    if ei < 0:
        return None
    return text[bi_end:ei]


# Wall-clock cap for the substantive `copilot -p` invocation. Mirrors the
# Codex section's 300s ceiling: comfortably above any normal model latency
# for a two-step shell-tool prompt; below the 10-minute Bash tool cap so a
# hung run cannot strand the harness.
COPILOT_EXEC_TIMEOUT_SECONDS = 300

# Shell rc files the harness snapshots for byte-identity verification (AC4).
# `bash -c 'export ...'` does NOT touch any rc file, but defense-in-depth
# (mirrors the Codex section's SHA256 round-trip on `~/.codex/config.toml`)
# catches any regression that accidentally modified the user's real rc.
_COPILOT_RC_CANDIDATES = (".bashrc", ".bash_profile", ".profile", ".zshrc")


def run_copilot_live_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """Copilot live section — exactly one `bash -c '… copilot -p …'` per Task 4.

    Sequence:

    1. PATH probe (``shutil.which("copilot")``); skip ``not-on-path`` on
       miss without invoking the binary.
    2. ``copilot --version`` sanity probe; skip ``not-authed`` on
       non-zero / timeout (covers a half-broken install).
    3. Auth probe (AC5): ``bash -c 'copilot -p "reply OK" --allow-all-tools'``
       with a 30s timeout. Timeout, non-zero exit, or output that does not
       contain ``OK`` records a SKIP with guidance pointing at GitHub
       Copilot CLI's auth flow.
    4. Snapshot every shell rc file in :data:`_COPILOT_RC_CANDIDATES` that
       exists, hash each via SHA256 BEFORE any mutation. The harness uses
       ``bash -c 'export …'`` rather than sourcing any rc, so none should
       change; the SHA256 round-trip is defense-in-depth that mirrors the
       Codex section's contract on ``~/.codex/config.toml``.
    5. Build a tmp install root directory containing the v2 query CLI and
       artifact schemas (``AGENTERA_HOME`` value for the export).
    6. Compose a combined prompt with the same marker brackets as Task 3
       (``===AGENTERA_HOME_ECHO_BEGIN===`` / ``===QUERY_OUTPUT_BEGIN===``)
       instructing the agent to (a) echo ``AGENTERA_HOME`` from a shell
       tool call and (b) run ``agentera query --list-artifacts`` via the
       exported install root.
    7. Issue exactly ONE invocation of the AC1 shape:
       ``bash -c 'export AGENTERA_HOME=<tmp>; copilot -p "<prompt>"
       --allow-all-tools'`` via ``subprocess.run(["bash", "-c", "..."])``.
       The literal bash-export form is required by AC1 to prove that
       Copilot inherits ``AGENTERA_HOME`` from a parent bash shell that
       exported it (matching the real-user shell-rc setup pattern).
    8. Parse the agent output between the markers and assert
       ``AGENTERA_HOME=<tmp install root>`` echoed back and the query output
       includes core artifact names.
    9. SHA256 each rc file AFTER and assert byte-identity vs the BEFORE
       hash for every snapshotted candidate (AC4).

    On any substantive failure step, hard-fail via :func:`fail` (the
    top-level ``finally`` still restores snapshots). The skip path covers
    only "binary missing or unauthenticated" cases per AC5; the user
    pre-authorized live spend and expects assertive verification.
    """
    info("--- copilot live section ---")

    # Step 1: PATH probe.
    if shutil.which("copilot") is None:
        skip("copilot", "not on PATH", skips)
        return
    info(f"probe: copilot resolved to {shutil.which('copilot')}")

    # Step 2: --version sanity probe.
    try:
        version_result = subprocess.run(
            ["copilot", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip(
            "copilot",
            "binary present but `copilot --version` timed out",
            skips,
        )
        return
    if version_result.returncode != 0:
        skip(
            "copilot",
            f"binary present but `copilot --version` exited "
            f"{version_result.returncode}",
            skips,
        )
        return
    info(f"probe: copilot {version_result.stdout.strip().splitlines()[0]}")

    # Step 3: AC5 auth probe via a deterministic 30s prompt under the
    # bash-export form (same shape as the substantive call so the probe
    # exercises the real surface). No `gh auth status` equivalent exists
    # for `copilot`; timeout / non-zero / missing-OK are all treated as
    # auth-required.
    auth_probe_cmd = (
        'copilot -p "reply with the literal text OK and nothing else" '
        '--allow-all-tools'
    )
    try:
        auth_result = subprocess.run(
            ["bash", "-c", auth_probe_cmd],
            capture_output=True,
            text=True,
            timeout=AUTH_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip(
            "copilot",
            f"binary present but auth probe timed out at "
            f"{AUTH_PROBE_TIMEOUT_SECONDS}s; run `copilot` interactively "
            f"to complete GitHub auth, then retry",
            skips,
        )
        return
    if auth_result.returncode != 0:
        skip(
            "copilot",
            f"binary present but auth probe exited "
            f"{auth_result.returncode}; run `copilot` interactively to "
            f"complete GitHub auth, then retry "
            f"(stderr={auth_result.stderr.strip()[:120]!r})",
            skips,
        )
        return
    if "OK" not in auth_result.stdout:
        skip(
            "copilot",
            f"auth probe returned 0 but output missing 'OK'; likely "
            f"unauthed or degraded; run `copilot` interactively to "
            f"complete GitHub auth "
            f"(stdout={auth_result.stdout.strip()[:120]!r})",
            skips,
        )
        return
    info("probe: copilot auth probe healthy (output contains 'OK')")

    # Step 4: snapshot real shell rc files BEFORE any mutation. Compute
    # SHA256 for each so the post-run check can prove byte-identity.
    rc_paths = [Path.home() / name for name in _COPILOT_RC_CANDIDATES]
    rc_paths = [p for p in rc_paths if p.exists()]
    rc_sha_before: dict[Path, str] = {}
    for rc in rc_paths:
        snapshots.snapshot(rc)
        rc_sha_before[rc] = _sha256(rc)
        info(f"copilot-rc sha256 (before) {rc}: {rc_sha_before[rc]}")

    # Step 5: build a tmp install root directory with the v2 query CLI.
    # Using a tmp install root (not REPO_ROOT) cleanly proves that the
    # bash-exported AGENTERA_HOME value is what propagates to copilot —
    # there is no way for the harness's parent process to have set it to
    # this fresh tmp path.
    with tempfile.TemporaryDirectory(
        prefix="agentera-smoke-copilot-home-"
    ) as tmp_install_root_str:
        tmp_install_root = Path(tmp_install_root_str)
        info(f"copilot: tmp AGENTERA_HOME={tmp_install_root}")
        _install_query_cli_bundle(tmp_install_root)

        with tempfile.TemporaryDirectory(
            prefix="agentera-smoke-copilot-query-"
        ) as tmp_workdir_str:
            tmp_workdir = Path(tmp_workdir_str)
            info(f"copilot: tmp workdir={tmp_workdir}")

            # Step 6: compose the combined prompt. Same marker shape as
            # Task 3 so the parser code path is shared. The prompt
            # contains no single quotes so it can be embedded inside the
            # bash -c '...' form without escape gymnastics.
            prompt = (
                "Run exactly these two shell commands (in order) using your "
                "shell tool. After running them, print the markers below "
                "with the captured outputs filled in.\n\n"
                'Command 1: echo "AGENTERA_HOME=$AGENTERA_HOME"\n'
                "Command 2: uv run \"$AGENTERA_HOME/scripts/agentera\" "
                "query --list-artifacts\n\n"
                "Then print this block as your final message, replacing "
                "<value1> and <value2> with the literal stdout you observed:\n\n"
                "===AGENTERA_HOME_ECHO_BEGIN===\n"
                "<value1>\n"
                "===AGENTERA_HOME_ECHO_END===\n"
                "===QUERY_OUTPUT_BEGIN===\n"
                "<value2>\n"
                "===QUERY_OUTPUT_END==="
            )

            # Step 7: exactly ONE bash -c invocation of the AC1 shape.
            # The prompt is wrapped in double quotes inside the bash -c
            # single-quoted script. Embedded double quotes inside the
            # prompt (e.g. `echo "AGENTERA_HOME=$AGENTERA_HOME"`) MUST
            # be escaped so bash does not terminate the outer "..."
            # early. shlex-style: replace " with \" and $ with \$ to
            # keep the prompt literal at the bash layer; copilot then
            # sees the unescaped form.
            escaped_prompt = (
                prompt.replace("\\", "\\\\")
                .replace('"', '\\"')
                .replace("$", "\\$")
                .replace("`", "\\`")
            )
            bash_script = (
                f"export AGENTERA_HOME={tmp_install_root}; "
                f'copilot -p "{escaped_prompt}" --allow-all-tools'
            )
            info(
                f"copilot: invoking `bash -c 'export AGENTERA_HOME={tmp_install_root}; "
                f"copilot -p \"...\" --allow-all-tools'`"
            )
            t0 = time.time()
            try:
                exec_result = subprocess.run(
                    ["bash", "-c", bash_script],
                    capture_output=True,
                    text=True,
                    timeout=COPILOT_EXEC_TIMEOUT_SECONDS,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                fail(
                    f"`copilot -p` timed out at "
                    f"{COPILOT_EXEC_TIMEOUT_SECONDS}s "
                    f"(partial stdout={exc.stdout!r})"
                )
                return  # unreachable; satisfies type checker
            elapsed = time.time() - t0
            info(
                f"copilot: `bash -c 'copilot -p ...'` returned "
                f"exit={exec_result.returncode} in {elapsed:.1f}s"
            )

            if exec_result.returncode != 0:
                stderr_lower = exec_result.stderr.lower()
                if "auth" in stderr_lower or "login" in stderr_lower:
                    skip(
                        "copilot",
                        f"`copilot -p` returned auth-style failure "
                        f"(exit {exec_result.returncode}); see stderr",
                        skips,
                    )
                    info(f"copilot: stdout={exec_result.stdout!r}")
                    info(f"copilot: stderr={exec_result.stderr!r}")
                    # fall through to rc SHA256 check before returning
                    _assert_rc_unchanged(rc_sha_before)
                    return
                fail(
                    f"`copilot -p` exit {exec_result.returncode}: "
                    f"stdout={exec_result.stdout!r} "
                    f"stderr={exec_result.stderr!r}"
                )

            agent_output = exec_result.stdout
            info("copilot: --- captured agent output begin ---")
            for line in agent_output.rstrip("\n").splitlines():
                info(f"  {line}")
            info("copilot: --- captured agent output end ---")

            # Step 8a: parse the AGENTERA_HOME echo between markers.
            ah_value = _extract_between(
                agent_output,
                "===AGENTERA_HOME_ECHO_BEGIN===",
                "===AGENTERA_HOME_ECHO_END===",
            )
            assert_true(
                ah_value is not None,
                "copilot: could not find AGENTERA_HOME echo markers in output",
            )
            assert ah_value is not None  # for type checker
            ah_value = ah_value.strip()
            expected_marker = f"AGENTERA_HOME={tmp_install_root}"
            assert_true(
                expected_marker in ah_value,
                f"copilot: AGENTERA_HOME echo {ah_value!r} does not "
                f"contain expected {expected_marker!r}",
            )
            info(f"copilot: AGENTERA_HOME echo verified: {ah_value}")

            # Step 8b: assert the query CLI resolved through AGENTERA_HOME.
            query_output = _extract_between(
                agent_output,
                "===QUERY_OUTPUT_BEGIN===",
                "===QUERY_OUTPUT_END===",
            )
            assert_true(
                query_output is not None,
                "copilot: could not find query output markers in output",
            )
            assert query_output is not None
            missing = [
                artifact
                for artifact in ("decisions", "progress", "session")
                if artifact not in query_output.split()
            ]
            assert_true(
                not missing,
                f"copilot: query output missing expected artifact names: {missing}; "
                f"output={query_output!r}",
            )
            info(f"copilot: query output verified: {query_output.strip()}")

    # Step 9: post-run SHA256 round-trip on every snapshotted rc file.
    _assert_rc_unchanged(rc_sha_before)

    info(
        "copilot: verified under `bash -c 'export AGENTERA_HOME=…; "
        "copilot -p … --allow-all-tools'`; user shell rc files "
        "byte-identical (SHA256 round-trip)"
    )


def _assert_rc_unchanged(rc_sha_before: dict[Path, str]) -> None:
    """Assert each snapshotted rc file's SHA256 matches the pre-run hash.

    Hard-fails on any mismatch so a regression that accidentally wrote
    to the user's real rc surfaces loudly. Logs each file's after-hash
    for operator audit even on the success path.
    """
    for rc, sha_before in rc_sha_before.items():
        sha_after = _sha256(rc)
        info(f"copilot-rc sha256 (after)  {rc}: {sha_after}")
        assert_true(
            sha_before == sha_after,
            f"copilot: rc SHA256 changed during harness run: "
            f"{rc} before={sha_before} after={sha_after}",
        )


OPENCODE_EXEC_TIMEOUT_SECONDS = 300


def run_opencode_live_section(
    snapshots: SnapshotRegistry,
    skips: list[tuple[str, str]],
) -> None:
    """OpenCode live section — one isolated ``opencode run`` invocation.

    This verifies OpenCode model-host behavior without loading Agentera skills:
    the command runs with ``--pure`` in a temporary workdir, exports a temporary
    ``AGENTERA_HOME``, and asks OpenCode to use its shell tool to echo that env
    value and run ``agentera query --list-artifacts`` through the exported
    install root. OpenCode data/config/cache paths are redirected to temporary
    XDG directories; if the user's ``auth.json`` exists it is copied into the
    temporary data dir so the live run can authenticate without writing to the
    real OpenCode store.
    """
    info("--- opencode live section ---")

    if shutil.which("opencode") is None:
        skip("opencode", "not on PATH", skips)
        return
    info(f"probe: opencode resolved to {shutil.which('opencode')}")

    try:
        version_result = subprocess.run(
            ["opencode", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        skip("opencode", "binary present but `opencode --version` timed out", skips)
        return
    if version_result.returncode != 0:
        skip(
            "opencode",
            f"binary present but `opencode --version` exited "
            f"{version_result.returncode}",
            skips,
        )
        return
    info(f"probe: opencode {version_result.stdout.strip()}")

    real_xdg_data = Path(
        os.path.expanduser(os.environ.get("XDG_DATA_HOME", "~/.local/share"))
    )
    real_auth = real_xdg_data / "opencode" / "auth.json"
    snapshots.snapshot(real_auth)
    auth_sha_before = _sha256(real_auth)
    info(f"opencode-auth sha256 (before): {auth_sha_before}")

    with tempfile.TemporaryDirectory(prefix="agentera-smoke-opencode-data-") as tmp_data_str:
        with tempfile.TemporaryDirectory(prefix="agentera-smoke-opencode-config-") as tmp_config_str:
            with tempfile.TemporaryDirectory(prefix="agentera-smoke-opencode-cache-") as tmp_cache_str:
                tmp_data = Path(tmp_data_str)
                tmp_config = Path(tmp_config_str)
                tmp_cache = Path(tmp_cache_str)
                if real_auth.exists():
                    tmp_auth = tmp_data / "opencode" / "auth.json"
                    tmp_auth.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(real_auth, tmp_auth)
                    info("opencode: copied auth.json into tmp XDG_DATA_HOME (authed)")
                else:
                    info(
                        "opencode: no auth.json found in real XDG_DATA_HOME; "
                        "live run will rely on provider environment variables"
                    )

                with tempfile.TemporaryDirectory(
                    prefix="agentera-smoke-opencode-home-"
                ) as tmp_install_root_str:
                    tmp_install_root = Path(tmp_install_root_str)
                    info(f"opencode: tmp AGENTERA_HOME={tmp_install_root}")
                    _install_query_cli_bundle(tmp_install_root)

                    with tempfile.TemporaryDirectory(
                        prefix="agentera-smoke-opencode-query-"
                    ) as tmp_workdir_str:
                        tmp_workdir = Path(tmp_workdir_str)
                        info(f"opencode: tmp workdir={tmp_workdir}")

                        prompt = (
                            "Run exactly these two shell commands (in order) using your "
                            "shell tool. After running them, print the markers below "
                            "with the captured outputs filled in.\n\n"
                            'Command 1: echo "AGENTERA_HOME=$AGENTERA_HOME"\n'
                            "Command 2: uv run \"$AGENTERA_HOME/scripts/agentera\" "
                            "query --list-artifacts\n\n"
                            "Then print this block as your final message, replacing "
                            "<value1> and <value2> with the literal stdout you observed:\n\n"
                            "===AGENTERA_HOME_ECHO_BEGIN===\n"
                            "<value1>\n"
                            "===AGENTERA_HOME_ECHO_END===\n"
                            "===QUERY_OUTPUT_BEGIN===\n"
                            "<value2>\n"
                            "===QUERY_OUTPUT_END==="
                        )

                        env = dict(os.environ)
                        env["AGENTERA_HOME"] = str(tmp_install_root)
                        env["XDG_DATA_HOME"] = str(tmp_data)
                        env["OPENCODE_CONFIG_DIR"] = str(tmp_config)
                        env["XDG_CACHE_HOME"] = str(tmp_cache)

                        cmd = [
                            "opencode",
                            "run",
                            "--pure",
                            "--dir",
                            str(tmp_workdir),
                            "--dangerously-skip-permissions",
                            prompt,
                        ]
                        info(
                            "opencode: invoking `opencode run --pure "
                            f"--dir {tmp_workdir} --dangerously-skip-permissions ...`"
                        )
                        t0 = time.time()
                        try:
                            exec_result = subprocess.run(
                                cmd,
                                env=env,
                                capture_output=True,
                                text=True,
                                timeout=OPENCODE_EXEC_TIMEOUT_SECONDS,
                                check=False,
                            )
                        except subprocess.TimeoutExpired as exc:
                            fail(
                                f"`opencode run` timed out at "
                                f"{OPENCODE_EXEC_TIMEOUT_SECONDS}s "
                                f"(partial stdout={exc.stdout!r})"
                            )
                            return
                        elapsed = time.time() - t0
                        info(
                            f"opencode: `opencode run` returned "
                            f"exit={exec_result.returncode} in {elapsed:.1f}s"
                        )

                        if exec_result.returncode != 0:
                            combined = f"{exec_result.stdout}\n{exec_result.stderr}".lower()
                            auth_markers = (
                                "auth",
                                "login",
                                "credential",
                                "credentials",
                                "unauthorized",
                                "api key",
                                "provider",
                            )
                            if any(marker in combined for marker in auth_markers):
                                skip(
                                    "opencode",
                                    f"`opencode run` returned auth-style failure "
                                    f"(exit {exec_result.returncode}); see output",
                                    skips,
                                )
                                info(f"opencode: stdout={exec_result.stdout!r}")
                                info(f"opencode: stderr={exec_result.stderr!r}")
                                _assert_opencode_auth_unchanged(real_auth, auth_sha_before)
                                return
                            fail(
                                f"`opencode run` exit {exec_result.returncode}: "
                                f"stdout={exec_result.stdout!r} "
                                f"stderr={exec_result.stderr!r}"
                            )

                        agent_output = exec_result.stdout
                        info("opencode: --- captured agent output begin ---")
                        for line in agent_output.rstrip("\n").splitlines():
                            info(f"  {line}")
                        info("opencode: --- captured agent output end ---")

                        ah_value = _extract_between(
                            agent_output,
                            "===AGENTERA_HOME_ECHO_BEGIN===",
                            "===AGENTERA_HOME_ECHO_END===",
                        )
                        assert_true(
                            ah_value is not None,
                            "opencode: could not find AGENTERA_HOME echo markers in output",
                        )
                        assert ah_value is not None
                        ah_value = ah_value.strip()
                        expected_marker = f"AGENTERA_HOME={tmp_install_root}"
                        assert_true(
                            expected_marker in ah_value,
                            f"opencode: AGENTERA_HOME echo {ah_value!r} does not "
                            f"contain expected {expected_marker!r}",
                        )
                        info(f"opencode: AGENTERA_HOME echo verified: {ah_value}")

                        query_output = _extract_between(
                            agent_output,
                            "===QUERY_OUTPUT_BEGIN===",
                            "===QUERY_OUTPUT_END===",
                        )
                        assert_true(
                            query_output is not None,
                            "opencode: could not find query output markers in output",
                        )
                        assert query_output is not None
                        missing = [
                            artifact
                            for artifact in ("decisions", "progress", "session")
                            if artifact not in query_output.split()
                        ]
                        assert_true(
                            not missing,
                            f"opencode: query output missing expected artifact names: "
                            f"{missing}; output={query_output!r}",
                        )
                        info(f"opencode: query output verified: {query_output.strip()}")

    _assert_opencode_auth_unchanged(real_auth, auth_sha_before)
    info(
        "opencode: verified under `opencode run --pure --dir <tmp> "
        "--dangerously-skip-permissions`; Agentera skills were not loaded "
        "and real OpenCode auth storage is byte-identical (SHA256 round-trip)"
    )


def _assert_opencode_auth_unchanged(real_auth: Path, sha_before: str) -> None:
    sha_after = _sha256(real_auth)
    info(f"opencode-auth sha256 (after): {sha_after}")
    assert_true(
        sha_before == sha_after,
        f"opencode: auth.json SHA256 changed during harness run: "
        f"before={sha_before} after={sha_after}",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="smoke_live_hosts.py",
        description=(
            "Live-host smoke harness for Codex, Copilot, and OpenCode AGENTERA_HOME "
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
    parser.add_argument(
        "--yes",
        action="store_true",
        help=(
            "Bypass the interactive consent prompt for non-interactive "
            "realisera/orkestrera dispatch. The cost line still prints "
            "and an explicit 'auto-consented via flag' audit line is "
            "emitted. Equivalent to setting "
            f"${CONSENT_ENV_VAR}=1 in the environment."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    snapshots = SnapshotRegistry()
    skips: list[tuple[str, str]] = []
    # Task 3 AC5: detect orphan snapshots from a prior crashed run and
    # restore them automatically so a half-finished prior invocation
    # cannot strand the user's real config files. Runs once at startup
    # before anything else touches the tmp surface.
    recover_orphan_snapshots()
    try:
        # Default-mode sections always run (also under --live), so a
        # live-mode invocation gets the offline gates as a precondition.
        run_codex_collection_audit()
        run_setup_helpers_smoke()

        if args.live:
            info("--- live mode: cost gate ---")
            if not cost_gate(auto_consent=args.yes):
                info("aborted: consent declined; no live CLI invoked")
                return 1
            run_codex_live_section(snapshots, skips)
            run_codex_hook_section(snapshots, skips)
            run_copilot_live_section(snapshots, skips)
            run_opencode_live_section(snapshots, skips)

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
