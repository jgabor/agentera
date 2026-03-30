# Enforcement Patterns

How to enforce a DESIGN.md visual identity beyond declaring tokens. Three layers, from cheap
and fast to thorough and periodic.

---

## Layer 1: Validation (framework-agnostic)

Validation checks that DESIGN.md is well-formed and that generated files stay in sync with it.
It catches malformed YAML, missing/duplicate markers, dangling token references, and generated
CSS/theme files that have drifted from the DESIGN.md source. Runs on every commit and in CI.

**Bundled tool:**

```bash
python3 -m scripts.validate_design --design DESIGN.md
```

**How depdevs wires it** (lefthook pre-commit):

```yaml
pre-commit:
  commands:
    validate-tokens:
      run: bun run validate:tokens
```

If someone edits the generated Tailwind theme directly instead of updating DESIGN.md, the
hook catches it. Generated files are never edited by hand -- DESIGN.md is the source of truth
and validation enforces this direction of flow.

---

## Layer 2: Linting (framework-specific)

Linting enforces design constraints at code-write time. Unlike validation (which checks the
design system itself), linting checks that *application code* respects the design system.

The `<!-- design:constraints -->` block in DESIGN.md declares **what** to enforce:

```yaml
aesthetic:
  - property: box-shadow
    rule: prohibited
    reason: "Depth via borders and contrast, not shadows"
  - property: border-radius
    rule: prohibited
    reason: "Sharp edges only"

structural:
  - pattern: arbitrary-values
    rule: prohibited
    scope: [colors, spacing, z-index]
  - pattern: inline-styles
    rule: prohibited
    exceptions: ["Progress", "Chart"]
```

Lint rules implement **how** to enforce those constraints for your specific framework. These
rules are necessarily stack-specific -- a Svelte/Tailwind project and a React/CSS Modules
project need completely different rule implementations for the same constraint.

### Example: depdevs lint rules (ESLint, Svelte/Tailwind)

depdevs implements 9 custom ESLint rules that map directly to its DESIGN.md constraints:

| Rule                        | Constraint it enforces                          | What it catches          | What the fix is                       |
| --------------------------- | ----------------------------------------------- | ------------------------ | ------------------------------------- |
| `no-arbitrary-colors`       | Use semantic color tokens                       | `bg-[#fff]`, `text-[red]` | Use `bg-background`, `text-foreground` |
| `no-shadow-classes`         | `box-shadow: prohibited`                        | `shadow-sm`, `shadow-lg`  | Remove shadow, use border instead     |
| `no-rounded-classes`        | `border-radius: prohibited`                     | `rounded-lg`, `rounded-md` | Remove or use `rounded-none`         |
| `no-arbitrary-spacing`      | `arbitrary-values: prohibited` (spacing scope)  | `p-[20px]`, `m-[2rem]`    | Use spacing scale: `p-4`, `m-8`      |
| `no-arbitrary-z-index`      | `arbitrary-values: prohibited` (z-index scope)  | `z-[50]`, `z-[999]`       | Use z-scale tokens: `z-overlay`       |
| `no-inline-style`           | `inline-styles: prohibited`                     | `style="color: red"`      | Use utility classes or variants       |
| `no-class-prop-on-component`| Components use variants, not class overrides    | `<Button class="...">`    | Use `<Button variant="ghost">`        |
| `enforce-variant-usage`     | UI components must use the variant system       | Raw Tailwind on components | Use `tv()` variant definitions        |

### Building your own rules

The pattern is:

1. Read the `<!-- design:constraints -->` block in your DESIGN.md
2. For each constraint, write a lint rule in your framework's linter
3. The rule scans templates/JSX/markup for violations of that specific constraint
4. Run the rules in your editor (immediate feedback) and in CI (gate)

You cannot generalize these rules across frameworks. A "no arbitrary colors" rule for Tailwind
classes looks nothing like the same rule for CSS-in-JS or vanilla CSS. Build them for your
stack.

---

## Layer 3: Audit (comprehensive)

Auditing is a periodic deep check that combines static analysis with visual inspection. It
catches violations that linting misses -- dynamic styles, computed classes, and visual
regressions that are only visible in the rendered output.

**Code scanning** -- AST-level analysis looking for non-semantic typography, conflicting style
declarations, color values outside `<!-- design:colors -->`, and component usage that bypasses
declared contracts.

**Visual inspection** -- screenshot rendered pages and verify output matches the declared
design. This catches what static analysis cannot: CSS specificity battles, third-party styles
bleeding through, and dynamic styling that only manifests at runtime.

### Example: depdevs audit

```bash
bun run audit:design
```

This runs two passes:

1. **AST scan** -- walks the Svelte component tree, extracts all style-related attributes and
   classes, and checks them against the DESIGN.md constraints
2. **Visual scan** -- launches Playwright, screenshots key pages, and analyzes the rendered
   output for prohibited visual properties

The output is a structured report:

```
DESIGN AUDIT REPORT
====================
Violations: 3
  WARN  src/lib/components/Card.svelte:14 — shadow-sm (prohibited: no shadows)
  WARN  src/routes/+page.svelte:8 — rounded-lg (prohibited: sharp edges)
  ERR   src/lib/theme.css:22 — #ff0000 (not in design:colors)

Screenshots: 4 pages captured
Visual check: PASS
```

---

## Wiring it together

| Layer      | When it runs        | What it catches                        | Speed     |
| ---------- | ------------------- | -------------------------------------- | --------- |
| Validation | Every commit + CI   | DESIGN.md structure, generated drift   | < 1s      |
| Linting    | Editor + commit + CI| Code-level constraint violations       | < 5s      |
| Audit      | Weekly / pre-release| Deep violations, visual regressions    | 30s - 2m  |

The layers are complementary. Validation ensures the source of truth is correct. Linting
prevents violations from being written. Auditing catches what slipped through.

Start with validation (it's free). Add lint rules incrementally as you find recurring
violations. Run audits before releases or on a schedule.
