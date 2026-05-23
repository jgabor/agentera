#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Measure live public JSON CLI surfaces from the D58 inventory manifest."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from measure_json_common import (  # noqa: E402
    CAPABILITIES,
    DEFAULT_TOKEN_COUNTER_COMMAND,
    count_gpt5_tokens,
    measure_payload,
    token_counter_display,
)

__all__ = [
    "CAPABILITIES",
    "DEFAULT_MANIFEST",
    "DEFAULT_TOKEN_COUNTER_COMMAND",
    "DEFAULT_LOCAL_BENCHMARK_COMMAND",
]

DEFAULT_MANIFEST = SCRIPT_DIR / "json_output_surface_manifest.yaml"
DEFAULT_LOCAL_BENCHMARK_COMMAND = (
    "uv run scripts/measure_json_output_surfaces.py --json --token-mode exact --enforce-budgets"
)
ENFORCEMENT_TIERS = frozenset({"enforce", "monitor", "exempt", "removed_3_0"})


@dataclass(frozen=True)
class SurfaceSpec:
    id: str
    command: str
    selector: str
    argv: list[str]
    inventory_classification: str
    budget_classification: str
    measurement_scope: str
    fixture: str
    enforcement_tier: str
    byte_budget: int | None
    token_budget: int | None
    exemption_rationale: str | None = None
    monitor_byte_ceiling: int | None = None
    capability: str | None = None
    profile: str | None = None


@dataclass(frozen=True)
class SurfaceMeasurement:
    id: str
    command: str
    selector: str
    capability: str | None
    profile: str | None
    bytes: int
    gpt5_tokens: int | None
    token_status: str
    budget_classification: str
    inventory_classification: str
    measurement_scope: str
    generation_status: str
    exit_code: int | None = None
    skip_reason: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class BudgetViolation:
    id: str
    command: str
    selector: str
    capability: str | None
    profile: str | None
    byte_count: int
    byte_budget: int
    token_count: int | None
    token_budget: int | None
    enforcement_tier: str
    reasons: list[str]


@dataclass(frozen=True)
class BudgetWarning:
    id: str
    command: str
    selector: str
    capability: str | None
    profile: str | None
    byte_count: int
    monitor_byte_ceiling: int
    enforcement_tier: str
    reason: str


def _load_manifest(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as stream:
        data = yaml.safe_load(stream)
    if not isinstance(data, dict) or "surfaces" not in data:
        raise ValueError(f"invalid manifest: {path}")
    return data


def _format_template(value: str, *, capability: str | None, repo_root: Path) -> str:
    return (
        value.replace("{capability}", capability or "")
        .replace("{repo_root}", str(repo_root))
    )


def _resolve_surface_budget(
    raw: dict[str, Any],
    *,
    capability: str | None,
) -> tuple[str, int | None, int | None, str | None, int | None]:
    tier = str(raw["enforcement_tier"])
    if tier not in ENFORCEMENT_TIERS:
        raise ValueError(f"surface {raw['id']!r}: invalid enforcement_tier {tier!r}")

    exemption_rationale = raw.get("exemption_rationale")
    if tier == "exempt" and not exemption_rationale:
        raise ValueError(f"surface {raw['id']!r}: exempt tier requires exemption_rationale")

    monitor_byte_ceiling = raw.get("monitor_byte_ceiling")
    if tier == "monitor" and monitor_byte_ceiling is None:
        raise ValueError(f"surface {raw['id']!r}: monitor tier requires monitor_byte_ceiling")

    byte_budget: int | None
    token_budget: int | None
    budget_by_capability = raw.get("budget_by_capability")
    if capability and budget_by_capability:
        cap_budget = budget_by_capability.get(capability)
        if cap_budget is None:
            raise ValueError(
                f"surface {raw['id']!r}: missing budget_by_capability entry for {capability!r}"
            )
        byte_budget = cap_budget.get("byte_budget")
        token_budget = cap_budget.get("token_budget")
    else:
        byte_budget = raw.get("byte_budget")
        token_budget = raw.get("token_budget")

    if tier == "enforce":
        if byte_budget is None or token_budget is None:
            raise ValueError(f"surface {raw['id']!r}: enforce tier requires byte_budget and token_budget")
    elif tier in {"exempt", "removed_3_0", "monitor"}:
        byte_budget = None
        token_budget = None

    return tier, byte_budget, token_budget, exemption_rationale, monitor_byte_ceiling


def _expand_surface(raw: dict[str, Any], repo_root: Path) -> list[SurfaceSpec]:
    argv = [_format_template(str(part), capability=None, repo_root=repo_root) for part in raw["argv"]]
    command = _format_template(str(raw["command"]), capability=None, repo_root=repo_root)
    expand_by = raw.get("expand_by")
    if expand_by == "capability":
        expanded: list[SurfaceSpec] = []
        for capability in CAPABILITIES:
            cap_tier, cap_byte, cap_token, cap_exempt, cap_monitor = _resolve_surface_budget(
                raw,
                capability=capability,
            )
            expanded.append(
                SurfaceSpec(
                    id=f"{raw['id']}:{capability}",
                    command=_format_template(str(raw["command"]), capability=capability, repo_root=repo_root),
                    selector=str(raw["selector"]),
                    argv=[
                        _format_template(str(part), capability=capability, repo_root=repo_root)
                        for part in raw["argv"]
                    ],
                    inventory_classification=str(raw["inventory_classification"]),
                    budget_classification=str(raw["budget_classification"]),
                    measurement_scope=str(raw["measurement_scope"]),
                    fixture=str(raw["fixture"]),
                    enforcement_tier=cap_tier,
                    byte_budget=cap_byte,
                    token_budget=cap_token,
                    exemption_rationale=cap_exempt,
                    monitor_byte_ceiling=cap_monitor,
                    capability=capability,
                    profile=raw.get("profile"),
                )
            )
        return expanded

    tier, byte_budget, token_budget, exemption_rationale, monitor_byte_ceiling = _resolve_surface_budget(
        raw,
        capability=raw.get("capability"),
    )
    return [
        SurfaceSpec(
            id=str(raw["id"]),
            command=command,
            selector=str(raw["selector"]),
            argv=argv,
            inventory_classification=str(raw["inventory_classification"]),
            budget_classification=str(raw["budget_classification"]),
            measurement_scope=str(raw["measurement_scope"]),
            fixture=str(raw["fixture"]),
            enforcement_tier=tier,
            byte_budget=byte_budget,
            token_budget=token_budget,
            exemption_rationale=exemption_rationale,
            monitor_byte_ceiling=monitor_byte_ceiling,
            capability=raw.get("capability"),
            profile=raw.get("profile"),
        )
    ]


def load_surface_specs(
    manifest_path: Path,
    repo_root: Path,
    *,
    scopes: set[str] | None = None,
) -> list[SurfaceSpec]:
    manifest = _load_manifest(manifest_path)
    specs: list[SurfaceSpec] = []
    for raw in manifest["surfaces"]:
        for spec in _expand_surface(raw, repo_root):
            if scopes is None or spec.measurement_scope in scopes:
                specs.append(spec)
    return specs


def _write_compaction_fixture(project: Path) -> None:
    (project / ".agentera").mkdir(exist_ok=True)
    (project / ".agentera" / "docs.yaml").write_text(
        "mapping:\n"
        "- artifact: TODO.md\n"
        "  path: state/TODO.md\n"
        "- artifact: PROGRESS.md\n"
        "  path: state/progress.yaml\n"
        "- artifact: DECISIONS.md\n"
        "  path: state/decisions.yaml\n"
        "- artifact: HEALTH.md\n"
        "  path: state/health.yaml\n",
        encoding="utf-8",
    )
    state = project / "state"
    state.mkdir(exist_ok=True)
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    cycles = [
        {
            "number": index,
            "timestamp": f"2026-05-{index:02d} 10:00",
            "type": "fix",
            "phase": "build",
            "what": f"fixture cycle {index}",
            "commit": "N/A",
        }
        for index in range(11, 0, -1)
    ]
    (state / "progress.yaml").write_text(
        yaml.safe_dump({"cycles": cycles, "archive": []}, sort_keys=False),
        encoding="utf-8",
    )
    (state / "decisions.yaml").write_text("decisions:\n- number: 1\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits:\n- number: 1\narchive: []\n", encoding="utf-8")


def _write_minimal_corpus(profile_dir: Path) -> None:
    intermediate = profile_dir / "intermediate"
    intermediate.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": {"extracted_at": "2026-05-23T00:00:00Z"},
        "records": [
            {
                "source_kind": "conversation_turn",
                "project": "fixture",
                "tokens": 1,
            }
        ],
    }
    (intermediate / "corpus.json").write_text(json.dumps(payload), encoding="utf-8")


class FixtureContext:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self._temp_dirs: list[tempfile.TemporaryDirectory[str]] = []
        self._cache: dict[str, tuple[Path, dict[str, str]]] = {}

    def close(self) -> None:
        while self._temp_dirs:
            self._temp_dirs.pop().cleanup()

    def _temp_dir(self) -> Path:
        temp = tempfile.TemporaryDirectory(prefix="agentera-measure-")
        self._temp_dirs.append(temp)
        return Path(temp.name)

    def resolve(self, fixture: str) -> tuple[Path, dict[str, str], list[str]]:
        if fixture in self._cache:
            cwd, env = self._cache[fixture]
            return cwd, env, []

        env = os.environ.copy()
        env["AGENTERA_HOME"] = str(self.repo_root)
        cleanup: list[str] = []

        if fixture == "repo_root":
            cwd = self.repo_root
        elif fixture == "isolated_compaction":
            # Never cache: check/fix/gate surfaces must not share one mutable project.
            cwd = self._temp_dir()
            _write_compaction_fixture(cwd)
            return cwd, env, cleanup
        elif fixture == "temp_app_home":
            home = self._temp_dir()
            cwd = self.repo_root
            env["AGENTERA_HOME"] = str(self.repo_root)
            cleanup = ["--home", str(home)]
        elif fixture == "temp_profile_empty":
            profile = self._temp_dir()
            cwd = self.repo_root
            env["PROFILERA_PROFILE_DIR"] = str(profile)
        elif fixture == "temp_profile_with_corpus":
            profile = self._temp_dir()
            _write_minimal_corpus(profile)
            cwd = self.repo_root
            env["PROFILERA_PROFILE_DIR"] = str(profile)
        elif fixture == "helper_usage_stats":
            cwd = self.repo_root
        else:
            raise ValueError(f"unsupported fixture {fixture!r}")

        self._cache[fixture] = (cwd, env)
        return cwd, env, cleanup


def _run_command(
    spec: SurfaceSpec,
    *,
    repo_root: Path,
    fixture_ctx: FixtureContext,
    extra_argv: list[str] | None = None,
) -> tuple[str, int, str | None]:
    cwd, env, cleanup = fixture_ctx.resolve(spec.fixture)
    extra_argv = extra_argv or cleanup

    if spec.fixture == "helper_usage_stats":
        command = [sys.executable, str(repo_root / "scripts" / "usage_stats.py"), *spec.argv[1:], *extra_argv]
    else:
        command = [sys.executable, str(repo_root / "scripts" / "agentera"), *spec.argv, *extra_argv]

    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    output = result.stdout
    if not output.strip():
        detail = result.stderr.strip() or f"exit {result.returncode}"
        return output, result.returncode, detail or "command produced empty stdout"
    try:
        json.loads(output)
    except json.JSONDecodeError as exc:
        detail = result.stderr.strip() or output.strip() or f"exit {result.returncode}"
        return output, result.returncode, f"stdout is not valid JSON: {exc}; detail={detail[:240]}"
    return output, result.returncode, None


def measure_surface(
    spec: SurfaceSpec,
    *,
    repo_root: Path,
    fixture_ctx: FixtureContext,
    token_counter: Callable[[str], int] | None,
) -> SurfaceMeasurement:
    try:
        output, exit_code, error = _run_command(spec, repo_root=repo_root, fixture_ctx=fixture_ctx)
    except Exception as exc:  # pragma: no cover - defensive for manual runs
        return SurfaceMeasurement(
            id=spec.id,
            command=spec.command,
            selector=spec.selector,
            capability=spec.capability,
            profile=spec.profile,
            bytes=0,
            gpt5_tokens=None,
            token_status="skipped" if token_counter is None else "unavailable",
            budget_classification=spec.budget_classification,
            inventory_classification=spec.inventory_classification,
            measurement_scope=spec.measurement_scope,
            generation_status="error",
            exit_code=None,
            error=str(exc),
        )

    if error is not None:
        if spec.enforcement_tier == "removed_3_0" and exit_code != 0:
            detail = f"{error}\n{output}".lower()
            if (
                "removed in agentera 3.0" in detail
                or "--capability-context" in detail
                or "--context-profile" in detail
            ):
                return SurfaceMeasurement(
                    id=spec.id,
                    command=spec.command,
                    selector=spec.selector,
                    capability=spec.capability,
                    profile=spec.profile,
                    bytes=len(output.encode("utf-8")),
                    gpt5_tokens=None,
                    token_status="skipped" if token_counter is None else "unavailable",
                    budget_classification=spec.budget_classification,
                    inventory_classification=spec.inventory_classification,
                    measurement_scope=spec.measurement_scope,
                    generation_status="removed",
                    exit_code=exit_code,
                    skip_reason="removed_3_0",
                )
        return SurfaceMeasurement(
            id=spec.id,
            command=spec.command,
            selector=spec.selector,
            capability=spec.capability,
            profile=spec.profile,
            bytes=len(output.encode("utf-8")),
            gpt5_tokens=None,
            token_status="skipped" if token_counter is None else "unavailable",
            budget_classification=spec.budget_classification,
            inventory_classification=spec.inventory_classification,
            measurement_scope=spec.measurement_scope,
            generation_status="error",
            exit_code=exit_code,
            error=error,
        )

    payload = measure_payload(output, token_counter)
    return SurfaceMeasurement(
        id=spec.id,
        command=spec.command,
        selector=spec.selector,
        capability=spec.capability,
        profile=spec.profile,
        bytes=payload.bytes,
        gpt5_tokens=payload.gpt5_tokens,
        token_status=payload.token_status,
        budget_classification=spec.budget_classification,
        inventory_classification=spec.inventory_classification,
        measurement_scope=spec.measurement_scope,
        generation_status="ok",
        exit_code=exit_code,
    )


def measure_surfaces(
    specs: list[SurfaceSpec],
    *,
    repo_root: Path,
    token_counter: Callable[[str], int] | None,
) -> list[SurfaceMeasurement]:
    fixture_ctx = FixtureContext(repo_root)
    try:
        return [
            measure_surface(spec, repo_root=repo_root, fixture_ctx=fixture_ctx, token_counter=token_counter)
            for spec in specs
        ]
    finally:
        fixture_ctx.close()


def measure_outputs(
    specs: list[SurfaceSpec],
    outputs: dict[str, str],
    token_counter: Callable[[str], int] | None,
) -> list[SurfaceMeasurement]:
    by_id = {spec.id: spec for spec in specs}
    missing = [spec.id for spec in specs if spec.id not in outputs]
    if missing:
        raise ValueError(f"missing surface outputs: {', '.join(missing)}")
    measurements: list[SurfaceMeasurement] = []
    for spec_id, output in outputs.items():
        spec = by_id[spec_id]
        payload = measure_payload(output, token_counter)
        measurements.append(
            SurfaceMeasurement(
                id=spec.id,
                command=spec.command,
                selector=spec.selector,
                capability=spec.capability,
                profile=spec.profile,
                bytes=payload.bytes,
                gpt5_tokens=payload.gpt5_tokens,
                token_status=payload.token_status,
                budget_classification=spec.budget_classification,
                inventory_classification=spec.inventory_classification,
                measurement_scope=spec.measurement_scope,
                generation_status="ok",
                exit_code=0,
            )
        )
    return measurements


def check_budget_violations(
    measurements: list[SurfaceMeasurement],
    specs: list[SurfaceSpec],
) -> tuple[list[BudgetViolation], list[BudgetWarning]]:
    spec_by_id = {spec.id: spec for spec in specs}
    violations: list[BudgetViolation] = []
    warnings: list[BudgetWarning] = []

    for measurement in measurements:
        if measurement.generation_status != "ok":
            continue
        spec = spec_by_id[measurement.id]
        tier = spec.enforcement_tier

        if tier in {"exempt", "removed_3_0"}:
            continue

        if tier == "monitor":
            if (
                spec.monitor_byte_ceiling is not None
                and measurement.bytes > spec.monitor_byte_ceiling
            ):
                warnings.append(
                    BudgetWarning(
                        id=measurement.id,
                        command=measurement.command,
                        selector=measurement.selector,
                        capability=measurement.capability,
                        profile=measurement.profile,
                        byte_count=measurement.bytes,
                        monitor_byte_ceiling=spec.monitor_byte_ceiling,
                        enforcement_tier=tier,
                        reason="monitor_ceiling_exceeded",
                    )
                )
            continue

        if tier != "enforce":
            continue
        if spec.byte_budget is None:
            continue

        reasons: list[str] = []
        if measurement.bytes > spec.byte_budget:
            reasons.append("bytes_exceeded")
        if (
            measurement.gpt5_tokens is not None
            and spec.token_budget is not None
            and measurement.gpt5_tokens > spec.token_budget
        ):
            reasons.append("tokens_exceeded")
        if not reasons:
            continue

        violations.append(
            BudgetViolation(
                id=measurement.id,
                command=measurement.command,
                selector=measurement.selector,
                capability=measurement.capability,
                profile=measurement.profile,
                byte_count=measurement.bytes,
                byte_budget=spec.byte_budget,
                token_count=measurement.gpt5_tokens,
                token_budget=spec.token_budget,
                enforcement_tier=tier,
                reasons=reasons,
            )
        )

    return violations, warnings


def report_payload(
    measurements: list[SurfaceMeasurement],
    *,
    manifest_path: Path,
    repo_root: Path,
    token_mode: str,
    token_counter_command: list[str],
    scopes: list[str],
    specs: list[SurfaceSpec],
    enforce_budgets: bool,
) -> dict[str, Any]:
    manifest = _load_manifest(manifest_path)
    errors = [measurement for measurement in measurements if measurement.generation_status == "error"]
    violations, warnings = check_budget_violations(measurements, specs)
    budget_status = "fail" if enforce_budgets and violations else "pass"
    if errors:
        status = "fail"
    elif enforce_budgets and violations:
        status = "fail"
    else:
        status = "pass"
    return {
        "command": "measure-json-output-surfaces",
        "status": status,
        "budget_status": budget_status,
        "manifest": str(manifest_path),
        "repo_root": str(repo_root),
        "scopes": scopes,
        "scope_notes": manifest.get("scope", {}),
        "surface_count": len(measurements),
        "error_count": len(errors),
        "violation_count": len(violations),
        "warning_count": len(warnings),
        "token_counter": {
            "mode": token_mode,
            "command": token_counter_display(token_counter_command),
            "local_benchmark_command": DEFAULT_LOCAL_BENCHMARK_COMMAND,
        },
        "measurements": [asdict(measurement) for measurement in measurements],
        "violations": [asdict(violation) for violation in violations],
        "warnings": [asdict(warning) for warning in warnings],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate and measure live public JSON CLI surfaces from "
            "scripts/json_output_surface_manifest.yaml."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Manual benchmark (exact GPT-5 tokens, requires npx tiktoken-cli):\n"
            f"  {DEFAULT_LOCAL_BENCHMARK_COMMAND}\n"
            "\n"
            "CI-safe bytes-only run with budget enforcement:\n"
            "  uv run scripts/measure_json_output_surfaces.py --json --token-mode skip --enforce-budgets"
        ),
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=SCRIPT_DIR.parent,
        help="repository root to measure",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="JSON output surface manifest YAML",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON report")
    parser.add_argument(
        "--scope",
        action="append",
        choices=["primary", "diagnostic"],
        help="limit measurement to manifest scope groups (repeatable; default: all in-scope scopes)",
    )
    parser.add_argument(
        "--token-mode",
        choices=["exact", "skip"],
        default="exact",
        help="exact runs `<output> | npx tiktoken-cli -m gpt-5`; skip records bytes only",
    )
    parser.add_argument(
        "--token-counter-command",
        default=shlex.join(DEFAULT_TOKEN_COUNTER_COMMAND),
        help="token counter command that reads payload text on stdin and emits an integer",
    )
    parser.add_argument(
        "--enforce-budgets",
        action="store_true",
        help="exit non-zero when enforce-tier byte or measured GPT-5 token budgets are exceeded",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    scopes = set(args.scope) if args.scope else {"primary", "diagnostic"}
    specs = load_surface_specs(args.manifest.resolve(), args.root.resolve(), scopes=scopes)
    token_counter_command = shlex.split(args.token_counter_command)
    token_counter = (
        (lambda output: count_gpt5_tokens(output, token_counter_command))
        if args.token_mode == "exact"
        else None
    )
    measurements = measure_surfaces(
        specs,
        repo_root=args.root.resolve(),
        token_counter=token_counter,
    )
    result = report_payload(
        measurements,
        manifest_path=args.manifest.resolve(),
        repo_root=args.root.resolve(),
        token_mode=args.token_mode,
        token_counter_command=token_counter_command,
        scopes=sorted(scopes),
        specs=specs,
        enforce_budgets=args.enforce_budgets,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("JSON output surface benchmark")
        print(f"manifest={result['manifest']}")
        print(f"scopes={','.join(result['scopes'])}")
        print(f"surfaces={result['surface_count']} errors={result['error_count']}")
        if args.enforce_budgets:
            print(
                f"budget_status={result['budget_status']} "
                f"violations={result['violation_count']} warnings={result['warning_count']}"
            )
        print(f"token_counter={result['token_counter']['command']}")
        print(f"local_benchmark_command={DEFAULT_LOCAL_BENCHMARK_COMMAND}")
        for measurement in measurements:
            tokens = (
                "skipped"
                if measurement.gpt5_tokens is None
                else str(measurement.gpt5_tokens)
            )
            print(
                f"{measurement.id}: status={measurement.generation_status} "
                f"bytes={measurement.bytes} gpt5_tokens={tokens} "
                f"budget={measurement.budget_classification}"
            )
            if measurement.error:
                print(f"  error={measurement.error}")
        if result["violations"]:
            print("violations:")
            for violation in result["violations"]:
                print(
                    f"{violation['id']}: command={violation['command']!r} "
                    f"selector={violation['selector']!r} "
                    f"bytes={violation['byte_count']}/{violation['byte_budget']} "
                    f"gpt5_tokens={violation['token_count']}/{violation['token_budget']} "
                    f"tier={violation['enforcement_tier']} "
                    f"reasons={','.join(violation['reasons'])}"
                )
        if result["warnings"]:
            print("warnings:")
            for warning in result["warnings"]:
                print(
                    f"{warning['id']}: command={warning['command']!r} "
                    f"selector={warning['selector']!r} "
                    f"bytes={warning['byte_count']}/{warning['monitor_byte_ceiling']} "
                    f"tier={warning['enforcement_tier']} reason={warning['reason']}"
                )
    if result["status"] == "fail":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
