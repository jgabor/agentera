# Harness Example: Lint / Code Quality Score

Measuring code quality via linting tools: violation counts, error scores, or quality ratings.

---

## ESLint (JavaScript/TypeScript)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(npx eslint --format json src/ 2>/dev/null) || true  # exits non-zero on violations

counts=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
errors = sum(f['errorCount'] for f in data)
warnings = sum(f['warningCount'] for f in data)
total = errors + warnings
print(json.dumps({'errors': errors, 'warnings': warnings, 'total': total}))
")
total=$(echo "$counts" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
errors=$(echo "$counts" | python3 -c "import sys,json; print(json.load(sys.stdin)['errors'])")
warnings=$(echo "$counts" | python3 -c "import sys,json; print(json.load(sys.stdin)['warnings'])")

echo "{\"metric\": $total, \"direction\": \"lower\", \"unit\": \"violations\", \"detail\": \"$errors errors + $warnings warnings\", \"breakdown\": [{\"name\": \"errors\", \"value\": $errors}, {\"name\": \"warnings\", \"value\": $warnings}]}"
```

## Pylint (Python)

Pylint outputs a 0-10 quality score:

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(python3 -m pylint --output-format=json src/ 2>/dev/null) || true
score=$(python3 -m pylint src/ --score=y 2>/dev/null | grep 'rated at' | grep -oP '[\d.]+(?=/10)') || score=0

errors=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(sum(1 for m in data if m['type'] == 'error'))
") || echo 0
warnings=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(sum(1 for m in data if m['type'] == 'warning'))
") || echo 0

echo "{\"metric\": $score, \"direction\": \"higher\", \"unit\": \"/10\", \"detail\": \"pylint score\", \"breakdown\": [{\"name\": \"errors\", \"value\": $errors}, {\"name\": \"warnings\", \"value\": $warnings}]}"
```

## golangci-lint (Go)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(golangci-lint run --out-format json ./... 2>/dev/null) || true

count=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
issues = data.get('Issues') or []
print(len(issues))
")
echo "{\"metric\": $count, \"direction\": \"lower\", \"unit\": \"issues\"}"
```

## Biome (JavaScript/TypeScript)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(npx biome check --reporter=json src/ 2>/dev/null) || true

count=$(echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('diagnostics', {}).get('total', 0))
") || echo 0
echo "{\"metric\": $count, \"direction\": \"lower\", \"unit\": \"diagnostics\"}"
```

## Choosing metric direction

Lint tools vary in what they output:
- **Violation counts** → `"direction": "lower"` (fewer is better)
- **Quality scores** (pylint's 0-10) → `"direction": "higher"` (higher is better)
- **Error ratios** → `"direction": "lower"` (lower is better)

Pick the one that most naturally maps to the user's objective. If the user says "clean up the linting," violation count with `"lower"` is the natural choice.
