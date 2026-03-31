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

## Open

## ISS-8: CLAUDE.md and DOCS.md have stale skill counts — degraded
CLAUDE.md says "Ten skills" (should be eleven). DOCS.md says "10/10 skills have SKILL.md"
(should be 11/11). Same staleness pattern as ISS-1 — doc references go stale immediately
on skill addition. Found in Audit 2.

## ISS-9: Resonera has duplicate "Getting started" sections — degraded
Two `## Getting started` headings at lines 98 and 312. First is misplaced mid-document
(all other skills put it at the end). First section describes workflow initiation ("If a
topic is provided"), second describes usage patterns ("Before a realisera session"). Should
be merged into one section at the end. Found in Audit 2.

## ISS-10: Some cross-skill references are unidirectional — annoying
inspektera says "feeds /optimera" but optimera doesn't acknowledge inspektera. dokumentera
feeds planera/realisera but neither acknowledges dokumentera. Not a logic error — all
relationships work correctly. Causes reading friction when discovering integration points.
Found in Audit 2.
