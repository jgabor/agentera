# Harness Example: Bundle Size

Measuring the size of build output (JS bundles, compiled binaries, Docker images).

---

## JavaScript bundle

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run build --silent 2>/dev/null || { echo "Build failed" >&2; exit 1; }

# Measure the main bundle
size=$(python3 -c "
import os, json
# Find the main output file — adapt path to your project
candidates = ['dist/index.js', 'build/index.js', '.next/static/chunks/main.js']
for c in candidates:
    if os.path.exists(c):
        print(os.path.getsize(c))
        break
else:
    print(-1)
")
if [ "$size" -eq -1 ]; then echo "Output file not found" >&2; exit 1; fi

kb=$(python3 -c "print(round($size / 1024, 2))")
echo "{\"metric\": $kb, \"direction\": \"lower\", \"unit\": \"KB\", \"detail\": \"main bundle\"}"
```

## Total build output

When the objective is total output size rather than a single file:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run build --silent 2>/dev/null || { echo "Build failed" >&2; exit 1; }

result=$(python3 -c "
import os, json
total = 0
breakdown = []
for root, dirs, files in os.walk('dist'):
    for f in files:
        path = os.path.join(root, f)
        size = os.path.getsize(path)
        total += size
        if f.endswith('.js'):
            breakdown.append({'name': os.path.relpath(path, 'dist'), 'value': round(size/1024, 2), 'unit': 'KB'})
breakdown.sort(key=lambda x: -x['value'])
print(json.dumps({
    'metric': round(total / 1024, 2),
    'direction': 'lower',
    'unit': 'KB',
    'detail': f'{len(breakdown)} JS files in dist/',
    'breakdown': breakdown[:10]
}))
")
echo "$result"
```

## Go binary

```bash
#!/usr/bin/env bash
set -euo pipefail
go build -o /tmp/optimera-measure ./cmd/myapp 2>/dev/null || {
  echo "Build failed" >&2; exit 1
}
size=$(python3 -c "import os; print(os.path.getsize('/tmp/optimera-measure'))")
mb=$(python3 -c "print(round($size / (1024*1024), 2))")
rm -f /tmp/optimera-measure
echo "{\"metric\": $mb, \"direction\": \"lower\", \"unit\": \"MB\"}"
```

## Docker image

```bash
#!/usr/bin/env bash
set -euo pipefail
docker build -t optimera-measure -q . 2>/dev/null || {
  echo "Docker build failed" >&2; exit 1
}
size=$(docker image inspect optimera-measure --format='{{.Size}}')
mb=$(python3 -c "print(round($size / (1024*1024), 2))")
docker rmi optimera-measure -f >/dev/null 2>&1
echo "{\"metric\": $mb, \"direction\": \"lower\", \"unit\": \"MB\"}"
```

## Gzipped size

For web bundles, gzipped size is often more relevant:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm run build --silent 2>/dev/null || { echo "Build failed" >&2; exit 1; }
raw=$(python3 -c "import os; print(os.path.getsize('dist/index.js'))")
gzip -k -f dist/index.js
gz=$(python3 -c "import os; print(os.path.getsize('dist/index.js.gz'))")
rm -f dist/index.js.gz
raw_kb=$(python3 -c "print(round($raw / 1024, 2))")
gz_kb=$(python3 -c "print(round($gz / 1024, 2))")
echo "{\"metric\": $gz_kb, \"direction\": \"lower\", \"unit\": \"KB\", \"detail\": \"gzipped (raw: ${raw_kb}KB)\", \"breakdown\": [{\"name\": \"raw\", \"value\": $raw_kb, \"unit\": \"KB\"}, {\"name\": \"gzipped\", \"value\": $gz_kb, \"unit\": \"KB\"}]}"
```
