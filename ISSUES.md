# Issues

## ISS-1: "Eight-skill ecosystem" in all SKILL.md files — critical
All 8 consuming SKILL.md cross-skill sections say "part of an eight-skill ecosystem" but the
suite has 9 skills. Contradicts README and CLAUDE.md. Mechanical fix: replace "eight" with
"nine" across all SKILL.md files.

## ISS-2: dokumentera doesn't consume PROFILE.md — degraded
README says PROFILE.md consumed by "all skills" but dokumentera has no profile reading step.
dokumentera can't calibrate doc style to user preferences. Fix: add decision profile reading
to dokumentera's orient steps (intent-first Step 1 and explore-and-generate Step 1).

## ISS-3: inspirera missing safety rails section — degraded
7 of 8 other skills have `## Safety rails` with `<critical>` tags. inspirera has none.
Fix: add safety rails section (never modify code, never write artifacts without confirmation,
read-only analysis unless explicitly asked to file findings).

## ISS-4: inspirera and profilera missing "Getting started" — degraded
7 of 9 skills have this section. Reduces usability for new users.
Fix: add getting started sections to both skills.

## ISS-5: Artifact path resolution wording inconsistencies — degraded
inspirera says "Before writing to" (omits reading), resonera says "cross-skill writes"
instead of "reads". Both deviate from the canonical pattern in realisera.
Fix: standardize wording to match realisera's canonical pattern.

## ISS-6: Missing bidirectional cross-skill references — annoying
- inspirera doesn't mention visionera (but visionera says "informed by /inspirera")
- planera doesn't mention dokumentera (but dokumentera says "feeds /planera (DTC pipeline)")
Fix: add the missing reverse references.
