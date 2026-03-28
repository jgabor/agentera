# Harness Example: Performance Benchmarks

Measuring execution time, throughput, or latency.

---

## Using hyperfine

[hyperfine](https://github.com/sharkdp/hyperfine) runs a command multiple times and reports
statistics. Good for CLI tools and scripts.

```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(hyperfine --json --warmup 3 --runs 10 'node dist/index.js' 2>/dev/null) || {
  echo "Benchmark failed" >&2; exit 1
}
mean_ms=$(echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(round(d['results'][0]['mean'] * 1000, 2))
")
stddev_ms=$(echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(round(d['results'][0]['stddev'] * 1000, 2))
")
echo "{\"metric\": $mean_ms, \"direction\": \"lower\", \"unit\": \"ms\", \"detail\": \"mean over 10 runs (stddev: ${stddev_ms}ms)\"}"
```

**Notes:**
- `--warmup 3` prevents cold-start skew
- `--runs 10` balances accuracy with speed
- hyperfine reports in seconds; multiply by 1000 for milliseconds

## Using the project's own benchmarks

Most projects have built-in benchmark infrastructure:

**Node (benchmark.js or vitest bench):**
```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(npx vitest bench --reporter=json 2>/dev/null) || {
  echo "Benchmark failed" >&2; exit 1
}
# Extract the specific benchmark being optimized
ops_per_sec=$(echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Navigate to the specific benchmark result
print(round(d['testResults'][0]['benchmarks'][0]['hz'], 2))
")
echo "{\"metric\": $ops_per_sec, \"direction\": \"higher\", \"unit\": \"ops/s\"}"
```

**Go:**
```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(go test -bench=BenchmarkSearch -benchtime=5s -count=3 ./... 2>&1) || {
  echo "Benchmark failed" >&2; exit 1
}
ns_per_op=$(echo "$result" | grep 'BenchmarkSearch' | awk '{print $3}' | head -1)
echo "{\"metric\": $ns_per_op, \"direction\": \"lower\", \"unit\": \"ns/op\"}"
```

**Python (pytest-benchmark):**
```bash
#!/usr/bin/env bash
set -euo pipefail
result=$(python3 -m pytest --benchmark-json=/dev/stdout tests/bench/ 2>/dev/null) || {
  echo "Benchmark failed" >&2; exit 1
}
mean_ms=$(echo "$result" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Mean of the specific benchmark in ms
print(round(d['benchmarks'][0]['stats']['mean'] * 1000, 4))
")
echo "{\"metric\": $mean_ms, \"direction\": \"lower\", \"unit\": \"ms\"}"
```

## HTTP endpoint latency

Using `wrk` or `ab` for web server benchmarks:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Start the server in the background
node dist/server.js &
SERVER_PID=$!
sleep 2  # wait for startup

# Run the benchmark
result=$(wrk -t2 -c10 -d10s --latency http://localhost:3000/api/search 2>&1) || {
  kill $SERVER_PID 2>/dev/null; echo "Benchmark failed" >&2; exit 1
}

# Extract p99 latency
p99=$(echo "$result" | grep '99%' | awk '{print $2}')

# Clean up
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

# Convert to ms (wrk outputs with unit suffix)
ms=$(python3 -c "
v = '$p99'
if v.endswith('ms'): print(float(v[:-2]))
elif v.endswith('us'): print(float(v[:-2]) / 1000)
elif v.endswith('s'): print(float(v[:-1]) * 1000)
")
echo "{\"metric\": $ms, \"direction\": \"lower\", \"unit\": \"ms\", \"detail\": \"p99 latency, 10s run, 10 connections\"}"
```

## Variance warning

Benchmarks have inherent variance. Document the expected noise level in OBJECTIVE.md so the
LLM knows that a 1% change might be noise while a 10% change is signal. Consider using more
runs (`--runs 20`) for noisy benchmarks, at the cost of longer harness execution time.
