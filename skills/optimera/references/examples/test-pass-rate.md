# Harness Example: Test Pass Rate

Measuring what percentage of the project's tests pass.

---

## Node (Jest / Vitest)

Jest and Vitest both support `--json` output:

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(npx jest --json --silent 2>/dev/null) || {
  echo "Test runner failed" >&2; exit 1
}
passed=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['numPassedTests'])")
total=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['numTotalTests'])")
if [ "$total" -eq 0 ]; then echo "No tests found" >&2; exit 1; fi
rate=$(python3 -c "print(round($passed / $total * 100, 2))")
echo "{\"metric\": $rate, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"$passed/$total tests passing\"}"
```

**Notes:**
- Uses `python3 -c` for JSON parsing and math instead of `jq`/`bc` (more portable)
- `--silent` suppresses console.log noise from tests
- Vitest: replace `npx jest` with `npx vitest run`

## Python (pytest)

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(python3 -m pytest --tb=no -q 2>&1) || true  # pytest exits non-zero on failures
passed=$(echo "$result" | grep -oP '\d+(?= passed)' || echo 0)
failed=$(echo "$result" | grep -oP '\d+(?= failed)' || echo 0)
errors=$(echo "$result" | grep -oP '\d+(?= error)' || echo 0)
total=$((passed + failed + errors))
if [ "$total" -eq 0 ]; then echo "No tests found" >&2; exit 1; fi
rate=$(python3 -c "print(round($passed / $total * 100, 2))")
echo "{\"metric\": $rate, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"$passed/$total tests passing\"}"
```

**Notes:**
- `|| true` after pytest because it exits non-zero when tests fail, and we still want the count
- `-q` for compact output, `--tb=no` to suppress tracebacks

## Go

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(go test ./... -json 2>/dev/null) || true
passed=$(echo "$result" | python3 -c "
import sys, json
passed = failed = 0
for line in sys.stdin:
    e = json.loads(line)
    if e.get('Action') == 'pass' and 'Test' in e: passed += 1
    elif e.get('Action') == 'fail' and 'Test' in e: failed += 1
print(passed)
")
failed=$(echo "$result" | python3 -c "
import sys, json
count = 0
for line in sys.stdin:
    e = json.loads(line)
    if e.get('Action') == 'fail' and 'Test' in e: count += 1
print(count)
")
total=$((passed + failed))
if [ "$total" -eq 0 ]; then echo "No tests found" >&2; exit 1; fi
rate=$(python3 -c "print(round($passed / $total * 100, 2))")
echo "{\"metric\": $rate, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"$passed/$total tests passing\"}"
```

## Rust

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(cargo test 2>&1) || true
passed=$(echo "$result" | grep -oP '\d+(?= passed)' || echo 0)
failed=$(echo "$result" | grep -oP '\d+(?= failed)' || echo 0)
total=$((passed + failed))
if [ "$total" -eq 0 ]; then echo "No tests found" >&2; exit 1; fi
rate=$(python3 -c "print(round($passed / $total * 100, 2))")
echo "{\"metric\": $rate, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"$passed/$total tests passing\"}"
```

## With breakdown

For richer signal, add per-suite breakdown:

```bash
echo "{\"metric\": $rate, \"direction\": \"higher\", \"unit\": \"%\", \"detail\": \"$passed/$total\", \"breakdown\": [{\"name\": \"unit\", \"value\": $unit_rate, \"unit\": \"%\"}, {\"name\": \"integration\", \"value\": $int_rate, \"unit\": \"%\"}]}"
```
