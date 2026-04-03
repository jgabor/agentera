"""Tests for skills/profilera/scripts/effective_profile.py.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained for compute_effective (math with decay/floor) and parse functions (regex).
"""

from __future__ import annotations

from datetime import date


# ---------------------------------------------------------------------------
# parse_entries
# ---------------------------------------------------------------------------

SAMPLE_PROFILE = """\
# Decision Profile

## Preferences

### Prefers explicit error handling

Observed across 4 sessions. Consistently chooses try/except over bare assertions.

`conf:82 | perm:durable | first:2026-01-15 | confirmed:2026-03-01 | challenged:\u2014`

### Favors functional style

Prefers map/filter/reduce patterns where possible.

`conf:65 | perm:situational | first:2026-02-10 | confirmed:2026-02-10 | challenged:2026-03-15`

### Uses dark mode

Always selects dark theme when configuring editors and terminals.

`conf:95 | perm:stable | first:2025-11-01 | confirmed:2026-01-20 | challenged:\u2014`
"""

PROFILE_NO_ENTRIES = """\
# Decision Profile

No entries yet.
"""


class TestParseEntries:
    """Complex: regex parsing of profile metadata. Keep all 3 (distinct paths)."""

    def test_parses_entries_with_metadata(self, effective_profile):
        entries = effective_profile.parse_entries(SAMPLE_PROFILE)
        assert len(entries) == 3
        assert entries[0]["name"] == "Prefers explicit error handling"
        assert entries[0]["conf"] == 82.0
        assert entries[0]["perm"] == "durable"
        assert entries[0]["first"] == "2026-01-15"
        assert entries[0]["confirmed"] == "2026-03-01"
        assert entries[0]["challenged"] == "\u2014"

    def test_challenged_date_parsed(self, effective_profile):
        entries = effective_profile.parse_entries(SAMPLE_PROFILE)
        assert entries[1]["challenged"] == "2026-03-15"

    def test_empty_profile(self, effective_profile):
        entries = effective_profile.parse_entries(PROFILE_NO_ENTRIES)
        assert entries == []


# ---------------------------------------------------------------------------
# compute_effective
# ---------------------------------------------------------------------------


class TestComputeEffective:
    """Complex: exponential decay math with confidence floor. Keep 3 distinct paths."""

    def test_fresh_entry_no_decay(self, effective_profile):
        """Entry confirmed today should have no decay."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 80.0,
            "perm": "durable",
            "first": "2026-04-01",
            "confirmed": "2026-04-01",
            "challenged": "\u2014",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        assert result["effective"] == 80.0
        assert result["days_stale"] == 0
        assert result["decay_gap"] == 0.0

    def test_decayed_entry(self, effective_profile):
        """Entry confirmed 30 days ago with durable decay should show decay."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 80.0,
            "perm": "durable",
            "first": "2026-01-01",
            "confirmed": "2026-03-02",
            "challenged": "\u2014",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        assert result["days_stale"] == 30
        assert result["effective"] < 80.0
        assert result["effective"] > 60.0
        assert result["decay_gap"] > 0

    def test_min_confidence_floor(self, effective_profile):
        """Entry with extreme staleness should not go below the floor."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 25.0,
            "perm": "situational",
            "first": "2025-01-01",
            "confirmed": "2025-01-01",
            "challenged": "\u2014",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        assert result["effective"] >= effective_profile.CONFIDENCE_FLOOR


# ---------------------------------------------------------------------------
# parse_lambdas
# ---------------------------------------------------------------------------

HEADER_WITH_LAMBDAS = """\
<!-- Decay parameters: stable \u03bb=0.002 durable \u03bb=0.008 situational \u03bb=0.020 -->
# Profile
"""

HEADER_WITHOUT_LAMBDAS = """\
# Profile

Just a profile with no explicit decay parameters.
"""


class TestParseLambdas:
    """Complex: regex extraction of decay parameters. Keep all 3 (distinct paths)."""

    def test_extracts_custom_lambdas(self, effective_profile):
        result = effective_profile.parse_lambdas(HEADER_WITH_LAMBDAS)
        assert result["stable"] == 0.002
        assert result["durable"] == 0.008
        assert result["situational"] == 0.020

    def test_defaults_when_absent(self, effective_profile):
        result = effective_profile.parse_lambdas(HEADER_WITHOUT_LAMBDAS)
        assert result == effective_profile.DEFAULT_LAMBDAS

    def test_partial_override(self, effective_profile):
        text = "<!-- stable \u03bb=0.003 -->"
        result = effective_profile.parse_lambdas(text)
        assert result["stable"] == 0.003
        assert result["durable"] == effective_profile.DEFAULT_LAMBDAS["durable"]
        assert result["situational"] == effective_profile.DEFAULT_LAMBDAS["situational"]
