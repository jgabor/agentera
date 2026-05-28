"""Regression tests for capability tool classification and agent descriptors."""

from __future__ import annotations

from pathlib import Path
import tomllib
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLASSIFICATION_PATH = REPO_ROOT / "references/cli/capability-tool-classification.yaml"
OPENCODE_DIR = REPO_ROOT / ".opencode/agents"
CODEX_DIR = REPO_ROOT / "skills/agentera/agents"
REGISTRY_PATH = REPO_ROOT / "references/adapters/runtime-adapter-registry.yaml"

CAPABILITIES = (
    "hej",
    "visionera",
    "resonera",
    "inspirera",
    "planera",
    "realisera",
    "optimera",
    "inspektera",
    "dokumentera",
    "profilera",
    "visualisera",
    "orkestrera",
)


def _load_classification():
    with CLASSIFICATION_PATH.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def test_classification_authority_structure():
    data = _load_classification()
    assert "classification" in data
    classification = data["classification"]

    assert "mutation_capable" in classification
    assert "contextual_write" in classification
    assert "read_only" in classification

    all_caps = []
    for tier in ("mutation_capable", "contextual_write", "read_only"):
        tier_data = classification[tier]
        assert "description" in tier_data
        assert "capabilities" in tier_data
        for cap, cap_data in tier_data["capabilities"].items():
            assert cap in CAPABILITIES
            all_caps.append(cap)
            assert "permission" in cap_data
            assert "write" in cap_data["permission"]
            assert "bash" in cap_data["permission"]
            assert cap_data["permission"]["write"] in ("allow", "deny")
            assert cap_data["permission"]["bash"] in ("allow", "deny")

    # Assert all 12 capabilities are unique and present
    assert len(all_caps) == 12
    assert set(all_caps) == set(CAPABILITIES)


def test_permission_values_by_tier():
    data = _load_classification()
    classification = data["classification"]

    # Mutation-capable must have write allow
    for cap, cap_data in classification["mutation_capable"]["capabilities"].items():
        assert cap_data["permission"]["write"] == "allow"

    # Contextual-write must have write allow
    for cap, cap_data in classification["contextual_write"]["capabilities"].items():
        assert cap_data["permission"]["write"] == "allow"

    # Read-only must have write and bash deny
    for cap, cap_data in classification["read_only"]["capabilities"].items():
        assert cap_data["permission"]["write"] == "deny"
        assert cap_data["permission"]["bash"] == "deny"


def test_opencode_descriptors_permission_frontmatter():
    data = _load_classification()
    class_map = {}
    for tier in ("mutation_capable", "contextual_write", "read_only"):
        for cap, cap_data in data["classification"][tier]["capabilities"].items():
            class_map[cap] = cap_data["permission"]

    for name in CAPABILITIES:
        path = OPENCODE_DIR / f"{name}.md"
        assert path.exists()
        text = path.read_text(encoding="utf-8")
        
        # Parse frontmatter
        lines = text.splitlines()
        assert lines[0] == "---"
        closing = lines.index("---", 1)
        frontmatter_text = "\n".join(lines[1:closing])
        frontmatter = yaml.safe_load(frontmatter_text)
        
        assert "permission" in frontmatter
        actual_permission = frontmatter["permission"]
        expected_permission = class_map[name]
        
        assert actual_permission["write"] == expected_permission["write"]
        assert actual_permission["bash"] == expected_permission["bash"]


def test_codex_descriptors_developer_instructions_guidance():
    data = _load_classification()
    class_map = {}
    for tier in ("mutation_capable", "contextual_write", "read_only"):
        for cap, cap_data in data["classification"][tier]["capabilities"].items():
            class_map[cap] = cap_data["permission"]

    for name in CAPABILITIES:
        path = CODEX_DIR / f"{name}.toml"
        assert path.exists()
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        
        dev_inst = parsed["developer_instructions"]
        permission = class_map[name]
        
        if permission["write"] == "allow" and permission["bash"] == "allow":
            expected_guidance = "You have full file write, file edit, and shell execution tools available"
        elif permission["write"] == "allow" and permission["bash"] == "deny":
            expected_guidance = "You have file write and file edit tools available to create or update files, but shell execution is disabled"
        else:
            expected_guidance = "You are a read-only agent — do not write files or execute shell commands"
            
        assert expected_guidance in dev_inst


def test_copilot_has_no_descriptors():
    with REGISTRY_PATH.open(encoding="utf-8") as f:
        registry = yaml.safe_load(f)
        
    copilot_record = None
    for record in registry["records"]:
        if record["identity"]["runtime_id"] == "copilot":
            copilot_record = record
            break
            
    assert copilot_record is not None
    assert copilot_record["subagent_dispatch"]["descriptor_sources"] == []


def test_runtime_adapter_registry_documents_tool_configuration():
    with REGISTRY_PATH.open(encoding="utf-8") as f:
        registry = yaml.safe_load(f)
        
    expected_tool_configs = {
        "claude": "none",
        "opencode": "per_agent_permission",
        "copilot": "none",
        "codex": "global_sandbox_policy",
        "cursor": "global_full_access",
        "cursor-agent": "global_full_access",
    }
    
    for record in registry["records"]:
        runtime_id = record["identity"]["runtime_id"]
        if runtime_id in expected_tool_configs:
            assert record["subagent_dispatch"]["tool_configuration"] == expected_tool_configs[runtime_id]
