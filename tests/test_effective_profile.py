"""Tests for skills/profilera/scripts/effective_profile.py."""

from __future__ import annotations

import math
from datetime import date


# ---------------------------------------------------------------------------
# parse_entries
# ---------------------------------------------------------------------------

SAMPLE_PROFILE = """\
# Decision Profile

## Preferences

### Prefers explicit error handling

Observed across 4 sessions. Consistently chooses try/except over bare assertions.

`conf:82 | perm:durable | first:2026-01-15 | confirmed:2026-03-01 | challenged:—`

### Favors functional style

Prefers map/filter/reduce patterns where possible.

`conf:65 | perm:situational | first:2026-02-10 | confirmed:2026-02-10 | challenged:2026-03-15`

### Uses dark mode

Always selects dark theme when configuring editors and terminals.

`conf:95 | perm:stable | first:2025-11-01 | confirmed:2026-01-20 | challenged:—`
"""

PROFILE_NO_ENTRIES = """\
# Decision Profile

No entries yet.
"""


class TestParseEntries:
    def test_parses_entries_with_metadata(self, effective_profile):
        entries = effective_profile.parse_entries(SAMPLE_PROFILE)
        assert len(entries) == 3
        assert entries[0]["name"] == "Prefers explicit error handling"
        assert entries[0]["conf"] == 82.0
        assert entries[0]["perm"] == "durable"
        assert entries[0]["first"] == "2026-01-15"
        assert entries[0]["confirmed"] == "2026-03-01"
        assert entries[0]["challenged"] == "—"

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
    def test_fresh_entry_no_decay(self, effective_profile):
        """Entry confirmed today should have no decay."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 80.0,
            "perm": "durable",
            "first": "2026-04-01",
            "confirmed": "2026-04-01",
            "challenged": "—",
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
            "challenged": "—",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        # 30 days stale with lambda=0.005 => exp(-0.005*30) = exp(-0.15) ~ 0.861
        # effective = 80 * 0.861 ~ 68.9
        assert result["days_stale"] == 30
        assert result["effective"] < 80.0
        assert result["effective"] > 60.0
        assert result["decay_gap"] > 0

    def test_heavily_decayed_entry(self, effective_profile):
        """Entry confirmed 200 days ago with situational decay should decay substantially."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 70.0,
            "perm": "situational",
            "first": "2025-06-01",
            "confirmed": "2025-09-13",
            "challenged": "—",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        # 200 days stale with lambda=0.015 => exp(-0.015*200) = exp(-3.0) ~ 0.05
        # effective = 70 * 0.05 = 3.5, but floor is 20
        assert result["days_stale"] == 200
        assert result["effective"] == effective_profile.CONFIDENCE_FLOOR

    def test_min_confidence_floor(self, effective_profile):
        """Entry with minimum confidence should not go below the floor."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 25.0,
            "perm": "situational",
            "first": "2025-01-01",
            "confirmed": "2025-01-01",
            "challenged": "—",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        assert result["effective"] >= effective_profile.CONFIDENCE_FLOOR

    def test_uses_confirmed_over_first(self, effective_profile):
        """When confirmed date exists, staleness should be from confirmed, not first."""
        today = date(2026, 4, 1)
        entry = {
            "name": "Test",
            "conf": 80.0,
            "perm": "durable",
            "first": "2025-01-01",  # very old
            "confirmed": "2026-03-31",  # yesterday
            "challenged": "—",
        }
        lambdas = effective_profile.DEFAULT_LAMBDAS
        result = effective_profile.compute_effective(entry, lambdas, today)
        assert result["days_stale"] == 1
        # With only 1 day stale, effective should be very close to conf
        assert result["effective"] > 79.0


# ---------------------------------------------------------------------------
# parse_lambdas
# ---------------------------------------------------------------------------

HEADER_WITH_LAMBDAS = """\
<!-- Decay parameters: stable λ=0.002 durable λ=0.008 situational λ=0.020 -->
# Profile
"""

HEADER_WITHOUT_LAMBDAS = """\
# Profile

Just a profile with no explicit decay parameters.
"""


class TestParseLambdas:
    def test_extracts_custom_lambdas(self, effective_profile):
        result = effective_profile.parse_lambdas(HEADER_WITH_LAMBDAS)
        assert result["stable"] == 0.002
        assert result["durable"] == 0.008
        assert result["situational"] == 0.020

    def test_defaults_when_absent(self, effective_profile):
        result = effective_profile.parse_lambdas(HEADER_WITHOUT_LAMBDAS)
        assert result == effective_profile.DEFAULT_LAMBDAS

    def test_partial_override(self, effective_profile):
        text = "<!-- stable λ=0.003 -->"
        result = effective_profile.parse_lambdas(text)
        assert result["stable"] == 0.003
        # Others remain at default
        assert result["durable"] == effective_profile.DEFAULT_LAMBDAS["durable"]
        assert result["situational"] == effective_profile.DEFAULT_LAMBDAS["situational"]
