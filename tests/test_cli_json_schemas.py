"""Tests verifying formal JSON Schema validation of all CLI --format json output surfaces."""

from __future__ import annotations

import json
from pathlib import Path
import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def validate_json_schema(data, schema, path=""):
    if schema is None:
        return

    allowed_types = schema.get("type")
    if allowed_types:
        if isinstance(allowed_types, str):
            allowed_types = [allowed_types]

        type_matched = False
        for t in allowed_types:
            if t == "string" and isinstance(data, str):
                type_matched = True
            elif t == "number" and isinstance(data, (int, float)) and not isinstance(data, bool):
                type_matched = True
            elif t == "integer" and isinstance(data, int) and not isinstance(data, bool):
                type_matched = True
            elif t == "boolean" and isinstance(data, bool):
                type_matched = True
            elif t == "null" and data is None:
                type_matched = True
            elif t == "array" and isinstance(data, list):
                type_matched = True
            elif t == "object" and isinstance(data, dict):
                type_matched = True

        if not type_matched:
            raise ValueError(
                f"At {path or 'root'}: expected type {allowed_types}, got {type(data).__name__} (value: {data!r})"
            )

    if "enum" in schema:
        if data not in schema["enum"]:
            raise ValueError(f"At {path or 'root'}: value {data!r} must be one of {schema['enum']}")

    if isinstance(data, list) and "items" in schema:
        for idx, item in enumerate(data):
            validate_json_schema(item, schema["items"], f"{path}[{idx}]")

    if isinstance(data, dict):
        if "required" in schema:
            for req in schema["required"]:
                if req not in data:
                    raise ValueError(f"At {path or 'root'}: missing required field {req!r}")
        if "properties" in schema:
            for key, val in data.items():
                if key in schema["properties"]:
                    validate_json_schema(val, schema["properties"][key], f"{path}.{key}" if path else key)


# Schema Definitions

SCHEMA_CLI_SCHEMA = {
    "type": "object",
    "required": [
        "schemaVersion",
        "command",
        "status",
        "source",
        "commands",
        "routine_state_commands",
        "structured_output",
        "field_selection",
        "slash_route_aliases",
        "artifact_schemas",
        "artifact_locations",
        "doctor",
        "gaps",
    ],
    "properties": {
        "schemaVersion": {"type": "string", "enum": ["agentera.schema.v1"]},
        "command": {"type": "string", "enum": ["schema"]},
        "status": {"type": "string", "enum": ["ok", "incomplete", "fail"]},
        "source": {
            "type": "object",
            "required": [
                "contract",
                "contract_exists",
                "schemas_dir",
                "schemas_dir_exists",
                "schema_count",
                "app_model",
            ],
            "properties": {
                "contract": {"type": "string"},
                "contract_exists": {"type": "boolean"},
                "schemas_dir": {"type": "string"},
                "schemas_dir_exists": {"type": "boolean"},
                "schema_count": {"type": "integer"},
                "app_model": {"type": "object"},
            },
        },
        "commands": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "kind", "description", "filters", "output_formats", "structured_fields"],
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string"},
                    "description": {"type": "string"},
                    "filters": {"type": "array", "items": {"type": "string"}},
                    "output_formats": {"type": "array", "items": {"type": "string"}},
                    "structured_fields": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "routine_state_commands": {"type": "array", "items": {"type": "string"}},
        "structured_output": {
            "type": "object",
            "required": ["formats", "fields_by_command"],
            "properties": {
                "formats": {"type": "array", "items": {"type": "string"}},
                "fields_by_command": {"type": "object"},
            },
        },
        "field_selection": {
            "type": "object",
            "required": ["syntax", "retained_context", "applies_to"],
            "properties": {
                "syntax": {"type": "string"},
                "retained_context": {"type": "array", "items": {"type": "string"}},
                "applies_to": {"type": "array", "items": {"type": "string"}},
            },
        },
        "slash_route_aliases": {
            "type": "object",
            "required": ["status", "aliases", "cli_commands_added", "note"],
            "properties": {
                "status": {"type": "string"},
                "aliases": {"type": "object"},
                "cli_commands_added": {"type": "boolean"},
                "note": {"type": "string"},
            },
        },
        "artifact_schemas": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "status", "schema_file", "path", "location", "artifact_type", "format", "producer", "consumers", "fields"],
                "properties": {
                    "name": {"type": "string"},
                    "status": {"type": "string"},
                    "schema_file": {"type": ["string", "null"]},
                    "path": {"type": "string"},
                    "location": {"type": ["object", "null"]},
                    "artifact_type": {"type": "string"},
                    "format": {"type": "string"},
                    "producer": {"type": ["string", "array"]},
                    "consumers": {"type": ["string", "array"]},
                    "fields": {"type": "array"},
                },
            },
        },
        "artifact_locations": {
            "type": "object",
            "required": ["artifacts", "caveats"],
            "properties": {
                "artifacts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": [
                            "artifact_id",
                            "name",
                            "display_name",
                            "artifact_type",
                            "format",
                            "producer",
                            "consumers",
                            "path",
                            "normal_read_command",
                            "advanced_query_command",
                            "raw_access_boundary",
                            "caveats",
                        ],
                        "properties": {
                            "artifact_id": {"type": "string"},
                            "name": {"type": "string"},
                            "display_name": {"type": "string"},
                            "artifact_type": {"type": "string"},
                            "format": {"type": "string"},
                            "producer": {"type": "array", "items": {"type": "string"}},
                            "consumers": {"type": "array", "items": {"type": "string"}},
                            "schema_file": {"type": ["string", "null"]},
                            "path": {
                                "type": "object",
                                "required": [
                                    "default_path",
                                    "mapped_path",
                                    "resolved_path",
                                    "display_path",
                                    "resolution_source",
                                    "exists",
                                    "docs_yaml_can_override_path",
                                    "project_boundary_check",
                                ],
                            },
                            "normal_read_command": {"type": ["string", "null"]},
                            "advanced_query_command": {"type": ["string", "null"]},
                            "raw_access_boundary": {
                                "type": "object",
                                "required": ["normal_policy", "allowed_raw_artifact_uses"],
                            },
                            "caveats": {"type": "array"},
                        },
                    },
                },
                "caveats": {"type": "array"},
            },
        },
        "doctor": {
            "type": "object",
            "required": [
                "command",
                "removed_command",
                "compatibility_alias",
                "self_check_categories",
                "excludes",
                "adjacent_surfaces",
                "signal_kinds",
            ],
        },
        "gaps": {"type": "array"},
    },
}

STATE_QUERY_ENVELOPE_SCHEMA = {
    "type": "object",
    "required": ["command", "status", "entries", "counts", "source", "filters"],
    "properties": {
        "command": {"type": "string"},
        "status": {"type": "string"},
        "entries": {"type": "array", "items": {"type": "object"}},
        "counts": {
            "type": "object",
            "required": ["entries"],
            "properties": {"entries": {"type": "integer"}},
        },
        "source": {
            "type": "object",
            "required": ["artifact", "path", "exists", "kind"],
            "properties": {
                "artifact": {"type": "string"},
                "path": {"type": "string"},
                "exists": {"type": "boolean"},
                "kind": {"type": "string"},
            },
        },
        "filters": {"type": ["object", "null"]},
        "summary": {"type": ["object", "null"]},
        "source_contract": {"type": ["object", "null"]},
    },
}

PRIME_SCHEMA = {
    "type": "object",
    "required": [
        "command",
        "status",
        "app_home",
        "bundle",
        "mode",
        "profile",
        "v1_migration",
        "health",
        "issues",
        "plan",
        "docs",
        "progress",
        "objective",
        "state_presence",
        "attention",
        "decision_attention",
        "next_action",
        "orchestration_context",
        "closeout_context",
        "evidence_context",
        "benchmark_context",
        "execution_context",
        "source",
        "source_contract",
    ],
    "properties": {
        "command": {"type": "string", "enum": ["prime", "hej"]},
        "status": {"type": "string"},
        "app_home": {"type": ["string", "object"]},
        "bundle": {"type": ["string", "object"]},
        "mode": {"type": "string"},
        "profile": {"type": ["string", "object"]},
        "v1_migration": {"type": ["string", "object", "null"]},
        "health": {"type": ["object", "null"]},
        "issues": {"type": ["object", "null"]},
        "plan": {"type": ["object", "null"]},
        "docs": {"type": ["object", "null"]},
        "progress": {"type": ["object", "null"]},
        "objective": {"type": ["object", "null"]},
        "state_presence": {
            "type": "object",
            "required": ["active", "available", "any_active", "absence_explained", "absence"],
        },
        "attention": {"type": "array", "items": {"type": "string"}},
        "decision_attention": {
            "type": ["object", "null"],
            "required": ["type", "count", "states", "entries", "max_entries", "bounded", "attention"],
        },
        "next_action": {"type": ["object", "null"]},
        "orchestration_context": {"type": ["object", "null"]},
        "closeout_context": {"type": ["object", "null"]},
        "evidence_context": {"type": ["object", "null"]},
        "benchmark_context": {"type": ["object", "null"]},
        "execution_context": {"type": ["object", "null"]},
        "source": {"type": "object"},
        "source_contract": {"type": "object"},
    },
}

CHECK_COMPACT_SCHEMA = {
    "type": "object",
    "required": ["command", "status", "project", "summary", "operations"],
    "properties": {
        "command": {"type": "string", "enum": ["compact", "gate"]},
        "status": {"type": "string"},
        "project": {"type": "string"},
        "gate": {"type": "string"},
        "summary": {
            "type": "object",
            "required": ["status", "mode", "artifact_count", "over_limit_count", "protected_overflow_count", "error_count", "changed_count", "action_counts", "guidance"],
        },
        "operations": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["artifact", "path", "exists", "classification", "active_count", "archive_count", "total_count", "over_limit_count", "protected_overflow_count", "mode", "action", "changed", "message"],
            },
        },
    },
}

CHECK_LINT_SCHEMA = {
    "type": "object",
    "required": ["command", "status", "artifact", "checks", "summary"],
    "properties": {
        "command": {"type": "string", "enum": ["lint"]},
        "status": {"type": "string", "enum": ["pass", "fail"]},
        "artifact": {"type": "string"},
        "path": {"type": "string"},
        "source": {"type": "string"},
        "strict": {"type": "boolean"},
        "checks": {"type": "array"},
        "summary": {"type": "object"},
    },
}

CHECK_VALIDATE_SCHEMA = {
    "type": "object",
    "required": ["command", "status", "target_family", "target", "violations"],
    "properties": {
        "command": {"type": "string", "enum": ["validate"]},
        "status": {"type": "string", "enum": ["pass", "fail"]},
        "target_family": {"type": "string"},
        "target": {"type": "string"},
        "violations": {"type": "array", "items": {"type": "string"}},
        "engine": {"type": "object"},
        "path": {"type": "string"},
        "checks": {"type": "array"},
        "summary": {"type": "object"},
        "artifact": {"type": "string"},
        "file": {"type": "string"},
        "docs_mapped_default": {"type": "string"},
        "path_source": {"type": "string"},
    },
}

CHECK_VERIFY_SCHEMA = {
    "type": "object",
    "required": ["command", "status", "family", "target", "format", "engine", "diagnostics", "safety"],
    "properties": {
        "command": {"type": "string", "enum": ["verify"]},
        "status": {"type": "string", "enum": ["pass", "fail"]},
        "family": {"type": "string", "enum": ["smoke", "eval"]},
        "target": {"type": "string"},
        "format": {"type": "string"},
        "engine": {
            "type": "object",
            "required": ["command", "exit_code"],
        },
        "diagnostics": {
            "type": "object",
            "required": ["stdout", "stderr", "line_limit"],
        },
        "safety": {"type": "object"},
    },
}

UPGRADE_SCHEMA = {
    "type": "object",
    "required": [
        "schemaVersion",
        "mode",
        "status",
        "lifecycleStatus",
        "compatibilityStatus",
        "project",
        "appHome",
        "summary",
        "phases",
    ],
    "properties": {
        "schemaVersion": {"type": "string", "enum": ["agentera.upgrade.v1"]},
        "mode": {"type": "string", "enum": ["plan", "apply"]},
        "status": {"type": "string", "enum": ["blocked", "failed", "pending", "noop"]},
        "lifecycleStatus": {"type": "string"},
        "compatibilityStatus": {"type": "string"},
        "project": {"type": "string"},
        "sourceRoot": {"type": "string"},
        "appHome": {"type": "string"},
        "managedAppRoot": {"type": "string"},
        "userDataRoot": {"type": "string"},
        "appHomeResolution": {"type": ["string", "null"]},
        "home": {"type": "string"},
        "runtimes": {"type": "array", "items": {"type": "string"}},
        "force": {"type": "boolean"},
        "updatePackages": {"type": "boolean"},
        "summary": {"type": "object"},
        "phases": {"type": "array"},
        "postflight": {"type": ["object", "null"]},
    },
}

DOCTOR_SCHEMA = {
    "type": "object",
    "required": ["schemaVersion", "status", "expectedVersion", "appHome", "managedAppRoot", "userDataRoot", "signals"],
    "properties": {
        "schemaVersion": {"type": "string", "enum": ["agentera.bundleStatus.v1"]},
        "status": {"type": "string"},
        "expectedVersion": {"type": "string"},
        "appHome": {"type": "string"},
        "managedAppRoot": {"type": "string"},
        "userDataRoot": {"type": "string"},
        "signals": {"type": "array"},
        "activeBundleRoot": {"type": "string"},
        "appHomeSource": {"type": "string"},
        "applyCommand": {"type": ["string", "null"]},
        "approval": {"type": ["string", "null"]},
        "authoritativeRoot": {"type": "string"},
        "dryRunCommand": {"type": ["string", "null"]},
        "home": {"type": "string"},
        "markerVersion": {"type": ["string", "null"]},
        "project": {"type": "string"},
        "retryCommand": {"type": ["string", "null"]},
        "rootStatus": {"type": "string"},
        "runtimeRoot": {"type": "string"},
        "skillRoot": {"type": "string"},
        "sourceRoot": {"type": "string"},
    },
}

USAGE_SCHEMA = {
    "type": "object",
    "required": [],
    "properties": {
        "generated_at": {"type": "string"},
        "extracted_at": {"type": "string"},
        "project_filter": {"type": ["string", "null"]},
        "skills": {"type": "object"},
        "invocations": {"type": "array"},
        "command": {"type": "string"},
        "status": {"type": "string"},
        "corpus_path": {"type": "string"},
        "reason": {"type": "string"},
        "next": {"type": "string"},
        "privacy": {"type": "object"},
    },
}

REPORT_SCHEMA = USAGE_SCHEMA

STATE_QUERY_LIST_ARTIFACTS_SCHEMA = {
    "type": "object",
    "required": ["schemaVersion", "command", "status", "names", "artifacts"],
    "properties": {
        "schemaVersion": {"type": "string"},
        "command": {"type": "string"},
        "status": {"type": "string"},
        "names": {"type": "array", "items": {"type": "string"}},
        "artifacts": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "artifact_id",
                    "name",
                    "display_name",
                    "artifact_type",
                    "format",
                    "producer",
                    "consumers",
                    "path",
                    "normal_read_command",
                    "advanced_query_command",
                    "raw_access_boundary",
                    "caveats",
                ],
            },
        },
    },
}


def get_schema_for_spec(spec_id: str) -> dict:
    if spec_id == "schema":
        return SCHEMA_CLI_SCHEMA
    if spec_id.startswith("prime-"):
        return PRIME_SCHEMA
    if spec_id.startswith("state-query-list-artifacts") or spec_id.startswith("query-list-artifacts"):
        return STATE_QUERY_LIST_ARTIFACTS_SCHEMA
    if spec_id == "state-query-last-phase":
        return {"type": "object", "required": ["phase"], "properties": {"phase": {"type": "string"}}}
    if spec_id.startswith("state-"):
        return STATE_QUERY_ENVELOPE_SCHEMA
    if spec_id.startswith("check-compact"):
        return CHECK_COMPACT_SCHEMA
    if spec_id.startswith("check-lint"):
        return CHECK_LINT_SCHEMA
    if spec_id.startswith("check-validate"):
        return CHECK_VALIDATE_SCHEMA
    if spec_id.startswith("check-verify"):
        return CHECK_VERIFY_SCHEMA
    if spec_id == "upgrade-dry-run":
        return UPGRADE_SCHEMA
    if spec_id == "doctor":
        return DOCTOR_SCHEMA
    if spec_id == "usage":
        return USAGE_SCHEMA
    if spec_id.startswith("report"):
        return REPORT_SCHEMA
    return STATE_QUERY_ENVELOPE_SCHEMA


@pytest.mark.slow
def test_all_json_surfaces_validate_against_schemas(
    measure_json_output_surfaces,
):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary", "diagnostic"})

    fixture_ctx = module.FixtureContext(REPO_ROOT)
    try:
        for spec in specs:
            if spec.enforcement_tier in ("removed_3_0", "exempt"):
                continue

            output, exit_code, error = module._run_command(spec, repo_root=REPO_ROOT, fixture_ctx=fixture_ctx)
            assert error is None, f"Surface {spec.id} failed to execute: {error}"

            # Parse json
            data = json.loads(output)

            # Get the expected schema
            schema = get_schema_for_spec(spec.id)

            if "--fields" in spec.argv:
                import copy
                schema = copy.deepcopy(schema)
                if "required" in schema:
                    schema["required"] = [r for r in schema["required"] if r in ("command", "status")]

            # Validate schema
            try:
                validate_json_schema(data, schema)
            except ValueError as exc:
                print(f"\nValidation failed for surface {spec.id}: {exc}")
                print(f"Payload: {json.dumps(data, indent=2)}")
                raise
    finally:
        fixture_ctx.close()
