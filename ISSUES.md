# Issues

## ~~ISS-1: "Eight-skill ecosystem" in all SKILL.md files — critical~~ RESOLVED
Fixed in 19a351f. All SKILL.md files now say "nine-skill ecosystem."

## ~~ISS-2: dokumentera doesn't consume PROFILE.md — degraded~~ RESOLVED
Fixed in 086c059. Profile reading added to intent-first and explore-and-generate modes.

## ~~ISS-3: inspirera missing safety rails section — degraded~~ RESOLVED
Fixed in 086c059. Safety rails section added with 5 critical guardrails.

## ~~ISS-4: inspirera and profilera missing "Getting started" — degraded~~ RESOLVED
Fixed in 086c059. Getting started sections added to both skills.

## ~~ISS-5: Artifact path resolution wording inconsistencies — degraded~~ RESOLVED
Fixed in 086c059. inspirera now says "Before reading or writing" (matches canonical),
resonera now says "cross-skill reads and writes."

## ~~ISS-6: Missing bidirectional cross-skill references — annoying~~ RESOLVED
Fixed in 086c059. Added inspirera→visionera and planera←dokumentera (DTC pipeline) references.

## ISS-7: Inspektera dedup uses single-signal "highest confidence wins" — degraded
Inspektera's Step 4 synthesis merges cross-dimension findings by taking the one with the
highest confidence score. When two dimensions flag the same underlying issue (e.g., coupling-health
finds a god-module's structural problem, complexity-hotspots finds its metric evidence), the
current approach discards the lower-confidence finding entirely. A three-tier preference —
fullest context → most evidence-rich dimension → latest — would preserve complementary evidence
from different audit angles. One-paragraph edit in `skills/inspektera/SKILL.md` Step 4.
Source: knowledge-synthesis skill (Anthropic) — multi-signal deduplication pattern.
