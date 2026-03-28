# Harness Example: Test Coverage

Measuring what percentage of the codebase is exercised by tests.

---

## Node (c8 / nyc / istanbul)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(npx c8 --reporter=json-summary npm test 2>/dev/null) || true

# c8 writes to coverage/coverage-summary.json
if [ ! -f coverage/coverage-summary.json ]; then
  echo "Coverage report not generated" >&2; exit 1
fi

metrics=$(python3 -c "
import json
with open('coverage/coverage-summary.json') as f:
    d = json.load(f)
t = d['total']
print(json.dumps({
    'lines': t['lines']['pct'],
    'branches': t['branches']['pct'],
    'functions': t['functions']['pct'],
    'statements': t['statements']['pct']
}))
")
lines=$(echo "$metrics" | python3 -c "import sys,json; print(json.load(sys.stdin)['lines'])")
branches=$(echo "$metrics" | python3 -c "import sys,json; print(json.load(sys.stdin)['branches'])")
functions=$(echo "$metrics" | python3 -c "import sys,json; print(json.load(sys.stdin)['functions'])")
statements=$(echo "$metrics" | python3 -c "import sys,json; print(json.load(sys.stdin)['statements'])")

echo "{\"metric\": $lines, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"line coverage\", \"breakdown\": [{\"name\": \"lines\", \"value\": $lines, \"unit\": \"%\"}, {\"name\": \"branches\", \"value\": $branches, \"unit\": \"%\"}, {\"name\": \"functions\", \"value\": $functions, \"unit\": \"%\"}, {\"name\": \"statements\", \"value\": $statements, \"unit\": \"%\"}]}"
```

## Python (coverage.py)

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m coverage run -m pytest 2>/dev/null || true
result=$(python3 -m coverage json -o /dev/stdout 2>/dev/null) || {
  echo "Coverage report failed" >&2; exit 1
}

pct=$(echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(round(d['totals']['percent_covered'], 2))
")
echo "{\"metric\": $pct, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"line coverage\"}"
```

## Go

```bash
#!/usr/bin/env bash
set -euo pipefail
go test -coverprofile=/tmp/coverage.out ./... 2>/dev/null || true

if [ ! -f /tmp/coverage.out ]; then
  echo "Coverage profile not generated" >&2; exit 1
fi

pct=$(go tool cover -func=/tmp/coverage.out | grep '^total:' | awk '{print $3}' | tr -d '%')
rm -f /tmp/coverage.out

echo "{\"metric\": $pct, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"function coverage\"}"
```

## Rust (cargo-tarpaulin)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(cargo tarpaulin --out json 2>/dev/null) || true

if [ ! -f tarpaulin-report.json ]; then
  echo "Coverage report not generated" >&2; exit 1
fi

pct=$(python3 -c "
import json
with open('tarpaulin-report.json') as f:
    d = json.load(f)
covered = d.get('covered', 0)
total = d.get('coverable', 1)
print(round(covered / total * 100, 2))
")
rm -f tarpaulin-report.json

echo "{\"metric\": $pct, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"line coverage\"}"
```

## Which coverage metric?

Coverage tools typically report multiple dimensions:
- **Line coverage**: percentage of lines executed (most common)
- **Branch coverage**: percentage of conditional branches taken
- **Function coverage**: percentage of functions called
- **Statement coverage**: similar to line but counts individual statements

Pick the one that matches the user's objective. Line coverage is the most common primary
metric. Branch coverage is a stronger signal but harder to improve. Use the breakdown to
report all dimensions even when optimizing just one.
