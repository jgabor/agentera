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

## ~~ISS-7: Inspektera dedup uses single-signal "highest confidence wins" — degraded~~ RESOLVED
Fixed in baff5b6. Dedup now uses three-tier preference: fullest context → most evidence-rich
dimension → latest. Complementary evidence preserved in merged entries.

## ~~ISS-8: CLAUDE.md and DOCS.md have stale skill counts — degraded~~ RESOLVED
Fixed in b11b018. CLAUDE.md → "Eleven skills", DOCS.md → "11/11".

## ~~ISS-9: Resonera has duplicate "Getting started" sections — degraded~~ RESOLVED
Fixed in b11b018. First section renamed to "Starting a session" (workflow step). Second
section remains as the real "Getting started" at end of file.

## ~~ISS-10: Some cross-skill references are unidirectional — annoying~~ RESOLVED
Fixed in 364727c. Added 9 reciprocal references across 8 skills: optimera←planera,
profilera←planera, inspirera←planera, planera←visionera, realisera←dokumentera,
realisera←visualisera, visionera←dokumentera, dokumentera←visualisera,
inspektera←visualisera.

## ~~ISS-11: Hej doesn't surface PROFILE.md's global path — degraded~~ RESOLVED
Fixed in b2dfa4a. Added global path notation to hej's state artifacts table, explicit
note in hej's artifact path resolution section, and global artifact note in ecosystem spec's
artifact table.

## Open

## ISS-12: README ecosystem diagram omits dokumentera — ⇉ degraded
Diagram shows 10 of 11 skills. Dokumentera is absent despite being consumed by all skills
for DOCS.md path resolution. Visual representation contradicts the "Eleven skills" claim.
Source: inspektera Audit 3, confidence 95.

## ISS-13: inspirera artifact path resolution in wrong location — ⇉ degraded
Artifact path resolution appears under `## Cross-skill integration` instead of `## State
artifacts`. Ecosystem spec Section 5 requires it under State artifacts. inspirera has no
State artifacts section at all. Source: inspektera Audit 3, confidence 100.

## ISS-14: hej cross-skill section has count and list gaps — ⇉ degraded
Line 227 says "all eleven workflow skills" — should be "ten other" (hej doesn't read
itself). Line 231 heading says "Reads from all ten skills" but lists only 8 (missing
profilera and inspirera). Source: inspektera Audit 3, confidence 90.

## ISS-15: profilera lacks State artifacts section — ⇉ degraded
Only skill of 11 without a `## State artifacts` section. Reads DECISIONS.md, writes
PROFILE.md (global path), but documents neither in a structured section with artifact
path resolution. Source: inspektera Audit 3, confidence 95.
