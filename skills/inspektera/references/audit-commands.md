# Audit Commands by Language

Concrete commands and patterns for each health dimension, organized by language/stack.
Agents should use these as starting points — adapt based on what the project actually has
installed.

---

## Architecture Alignment

### TypeScript / Node

```bash
# Map module boundaries — directory structure as architecture
find src -type d -maxdepth 2 | sort

# Trace barrel exports to see what each module exposes
grep -r "export \* from\|export {" src/ --include="*.ts" | head -40

# Check for layer violations — e.g., domain importing from infrastructure
grep -rn "from ['\"].*\/infra\|from ['\"].*\/database\|from ['\"].*\/http" src/domain/ --include="*.ts"

# Check for circular re-exports via tsconfig paths
cat tsconfig.json | grep -A 20 '"paths"'
```

### Go

```bash
# List all packages and their import paths
go list ./...

# Show internal package boundaries
find . -name "*.go" -path "*/internal/*" | sed 's|/[^/]*$||' | sort -u

# Check for layer violations — internal packages imported from outside
grep -rn '".*internal/' --include="*.go" | grep -v "_test.go" | grep -v "/internal/"
```

### SQL

```bash
# Map schema structure — tables, views, functions
grep -i "CREATE TABLE\|CREATE VIEW\|CREATE FUNCTION\|CREATE PROCEDURE" *.sql migrations/*.sql

# Check for cross-schema references (coupling between schemas)
grep -i "FROM\|JOIN" *.sql | grep -oP '\w+\.\w+\.\w+' | sort -u
```

### Bash

```bash
# Map script dependency graph — which scripts source/call others
grep -rn "source \|^\. \|bash \|sh " --include="*.sh" | grep -v "#"

# Check for scripts that bypass the intended entry points
grep -rn "direct call\|DO NOT\|sourced by" --include="*.sh" | head -20
```

---

## Pattern Consistency

### TypeScript / Node

```bash
# Error handling patterns — throws vs returns vs Result types
grep -rn "throw new\|catch (\|\.catch(\|Result<\|Either<" src/ --include="*.ts" | head -40

# Naming conventions — check for mixed styles
grep -rn "function [a-z_]*(" src/ --include="*.ts" | head -20  # snake_case functions
grep -rn "function [a-z][a-zA-Z]*(" src/ --include="*.ts" | head -20  # camelCase functions

# Export patterns — default vs named
grep -c "export default" src/**/*.ts 2>/dev/null | grep -v ":0$"
grep -c "export function\|export const\|export class" src/**/*.ts 2>/dev/null | grep -v ":0$"

# Async patterns — callbacks vs promises vs async/await
grep -rn "callback\|\.then(\|async " src/ --include="*.ts" | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head -10

# Config access patterns
grep -rn "process\.env\.\|config\.\|getConfig\|dotenv" src/ --include="*.ts" | head -20
```

### Go

```bash
# Error handling — check for consistent wrapping style
grep -rn 'fmt\.Errorf.*%w\|errors\.Wrap\|errors\.New\|return err$' --include="*.go" | head -40

# Naming — exported types and functions
grep -rn "^func [A-Z]\|^type [A-Z]" --include="*.go" | head -30

# Context propagation — should be consistent
grep -rn "context\.Background()\|context\.TODO()" --include="*.go"

# Struct initialization — literal vs constructor
grep -rn "New[A-Z]\w*(" --include="*.go" | head -20
grep -rn "&[A-Z]\w*{" --include="*.go" | head -20

# Logging patterns
grep -rn "log\.\|slog\.\|zap\.\|logrus\.\|zerolog\." --include="*.go" | awk -F: '{print $1}' | sort | uniq -c | sort -rn | head -10
```

### SQL

```bash
# Naming conventions — table and column naming
grep -iP "CREATE TABLE\s+\K\w+" *.sql migrations/*.sql | sort -u

# Constraint patterns — are foreign keys, NOT NULLs, defaults used consistently?
grep -ic "FOREIGN KEY\|REFERENCES\|NOT NULL\|DEFAULT" migrations/*.sql

# Index naming conventions
grep -i "CREATE INDEX\|CREATE UNIQUE INDEX" migrations/*.sql | head -20
```

### Bash

```bash
# Quoting discipline — unquoted variables are bugs
grep -rn '\$[a-zA-Z_]' --include="*.sh" | grep -v '".*\$.*"' | grep -v "'\$" | head -30

# Error handling — set -e / set -euo pipefail usage
head -5 *.sh scripts/*.sh 2>/dev/null

# Function definition style consistency
grep -rn "^function \|^[a-z_]* ()" --include="*.sh" | head -20

# Logging/output patterns
grep -rn "echo \|printf \|>&2" --include="*.sh" | head -20
```

---

## Coupling Health

### TypeScript / Node

```bash
# Import graph — who imports whom (top importers)
grep -rn "^import " src/ --include="*.ts" | awk -F"from " '{print $2}' | sort | uniq -c | sort -rn | head -20

# Fan-in — most imported modules (god modules)
grep -rn "from ['\"]" src/ --include="*.ts" | grep -oP "from ['\"]([^'\"]+)" | sort | uniq -c | sort -rn | head -15

# Circular dependency detection (if madge is installed)
npx madge --circular src/ 2>/dev/null || echo "madge not installed — trace manually"

# Cross-boundary imports — modules reaching into other modules' internals
grep -rn "from ['\"]\.\./" src/ --include="*.ts" | head -30
```

### Go

```bash
# Import graph summary — packages with most imports
go list -f '{{.ImportPath}}: {{len .Imports}} imports' ./... | sort -t: -k2 -rn | head -15

# Fan-in — most depended-on packages
go list -f '{{range .Imports}}{{.}}{{"\n"}}{{end}}' ./... | sort | uniq -c | sort -rn | head -15

# Circular dependency detection
go vet ./... 2>&1 | grep "import cycle"

# Interface width — exported symbols per package
go doc ./... 2>/dev/null | grep "^func \|^type \|^var \|^const " | wc -l
```

### SQL

```bash
# Table coupling — foreign key relationships
grep -i "REFERENCES\|FOREIGN KEY" migrations/*.sql | head -20

# Cross-table query coupling — JOINs reveal runtime coupling
grep -ic "JOIN" *.sql | sort -t: -k2 -rn | head -15

# Stored procedure dependencies — procs calling other procs
grep -i "CALL \|EXEC " *.sql | head -20
```

### Bash

```bash
# Script coupling — which scripts depend on which
grep -rn "source \|^\. " --include="*.sh" | head -20

# Shared global state — exported variables
grep -rn "^export " --include="*.sh" | head -20

# External command dependencies
grep -rn "which \|command -v " --include="*.sh" | head -20
```

---

## Complexity Hotspots

### TypeScript / Node

```bash
# Long files (lines of code, excluding tests)
find src -name "*.ts" ! -name "*.test.*" ! -name "*.spec.*" -exec wc -l {} + | sort -rn | head -15

# Long functions — rough proxy via brace depth analysis
grep -rn "^  function \|^  async function \|=> {$" src/ --include="*.ts" | head -20

# Deep nesting — lines with heavy indentation (4+ levels)
grep -rn "^                " src/ --include="*.ts" | wc -l

# High fan-out — functions with many function calls on single lines
grep -rn "\w(.*\w(.*\w(" src/ --include="*.ts" | head -15

# Switch/conditional sprawl
grep -c "case \|if (\|else if\|? :" src/**/*.ts 2>/dev/null | sort -t: -k2 -rn | head -10

# Parameter count — functions with 5+ params
grep -rn "function.*,.*,.*,.*," src/ --include="*.ts" | head -15
```

### Go

```bash
# Long files
find . -name "*.go" ! -name "*_test.go" -exec wc -l {} + | sort -rn | head -15

# Long functions — go vet or staticcheck can help, otherwise estimate
grep -c "^func " *.go **/*.go 2>/dev/null | sort -t: -k2 -rn | head -10

# Cyclomatic complexity (if gocyclo is installed)
gocyclo -over 10 . 2>/dev/null || echo "gocyclo not installed — check manually"

# Deep nesting
grep -rn "^\t\t\t\t" --include="*.go" | grep -v "_test.go" | wc -l

# High parameter count
grep -rn "^func.*,.*,.*,.*," --include="*.go" | head -15
```

### SQL

```bash
# Long queries/procedures
grep -c ";" *.sql | sort -t: -k2 -rn | head -10

# Subquery nesting depth
grep -ic "SELECT.*SELECT\|(\s*SELECT" *.sql | sort -t: -k2 -rn | head -10

# Complex JOINs — queries with 4+ joins
grep -i "JOIN" *.sql | awk '{c++} /;/{if(c>=4) print FILENAME":"NR" ("c" joins)"; c=0}'
```

### Bash

```bash
# Long scripts
find . -name "*.sh" -exec wc -l {} + | sort -rn | head -15

# Deep nesting — if/for/while depth
grep -rn "^        " --include="*.sh" | wc -l

# Long pipelines (4+ pipes)
grep -rn "|.*|.*|.*|" --include="*.sh" | head -10

# Functions with no error handling
grep -A5 "^[a-z_]* ()" --include="*.sh" | grep -L "set -e\||| \|trap " | head -10
```

---

## Test Health

### TypeScript / Node

```bash
# Test-to-source ratio
echo "Source:" && find src -name "*.ts" ! -name "*.test.*" ! -name "*.spec.*" | wc -l
echo "Tests:" && find src -name "*.test.*" -o -name "*.spec.*" | wc -l

# Modules with no tests
for d in src/*/; do
  tests=$(find "$d" -name "*.test.*" -o -name "*.spec.*" | wc -l)
  [ "$tests" -eq 0 ] && echo "NO TESTS: $d"
done

# Coverage (if configured)
npx vitest run --coverage 2>/dev/null || npx jest --coverage 2>/dev/null || echo "No coverage tool detected"

# Mock density — excessive mocking is a smell
grep -rc "jest\.mock\|vi\.mock\|sinon\.\|mock(" src/ --include="*.test.*" | sort -t: -k2 -rn | head -10

# Test naming — can you tell what failed from the name?
grep -rn "it('\|test('\|describe('" src/ --include="*.test.*" | head -20
```

### Go

```bash
# Test-to-source ratio
echo "Source:" && find . -name "*.go" ! -name "*_test.go" | wc -l
echo "Tests:" && find . -name "*_test.go" | wc -l

# Packages with no tests
for d in $(go list ./...); do
  dir=$(go list -f '{{.Dir}}' "$d")
  tests=$(find "$dir" -maxdepth 1 -name "*_test.go" | wc -l)
  [ "$tests" -eq 0 ] && echo "NO TESTS: $d"
done

# Coverage
go test ./... -coverprofile=coverage.out -count=1 2>/dev/null && go tool cover -func=coverage.out | tail -1

# Table-driven test usage (idiomatic Go)
grep -rc "tests := \[\]struct\|testCases\|tt\.Run\|tc\.Run" --include="*_test.go" | sort -t: -k2 -rn | head -10

# Test helpers vs test functions ratio
grep -c "^func Test\|^func Benchmark" *_test.go **/*_test.go 2>/dev/null | sort -t: -k2 -rn | head -10
```

### SQL

```bash
# Check for test schemas or test data scripts
find . -name "*test*" -o -name "*seed*" -o -name "*fixture*" | head -10

# Migration test coverage — are migrations tested?
find . -name "*migration*test*" -o -name "*migrate*test*" | head -10
```

### Bash

```bash
# Test scripts present?
find . -name "*test*" -name "*.sh" -o -name "*spec*" -name "*.sh" | head -10

# BATS or shunit2 usage
grep -rl "bats\|shunit2\|@test" --include="*.sh" --include="*.bats" | head -10

# ShellCheck compliance (if installed)
shellcheck *.sh scripts/*.sh 2>/dev/null | head -40 || echo "shellcheck not installed"
```

---

## Dependency Health

### TypeScript / Node

```bash
# Outdated dependencies
npm outdated 2>/dev/null || yarn outdated 2>/dev/null || pnpm outdated 2>/dev/null

# Security vulnerabilities
npm audit 2>/dev/null || yarn audit 2>/dev/null || pnpm audit 2>/dev/null

# Unused dependencies (if depcheck is installed)
npx depcheck 2>/dev/null || echo "depcheck not available — trace imports manually"

# Dependency count
jq '.dependencies | length' package.json 2>/dev/null
jq '.devDependencies | length' package.json 2>/dev/null

# Pinning discipline
grep -c '"\^' package.json   # caret ranges (loose)
grep -c '"~' package.json    # tilde ranges (moderate)
grep -c '"[0-9]' package.json  # exact pins

# Lock file present?
ls package-lock.json yarn.lock pnpm-lock.yaml 2>/dev/null
```

### Go

```bash
# Outdated dependencies
go list -m -u all 2>/dev/null | grep "\[" | head -20

# Security vulnerabilities
govulncheck ./... 2>/dev/null || echo "govulncheck not installed"

# Direct vs indirect dependency count
grep -c "require" go.mod
grep -c "// indirect" go.sum

# Unused dependencies
go mod tidy -diff 2>/dev/null || echo "run 'go mod tidy' to check"

# Replace directives (local overrides)
grep "replace" go.mod
```

### SQL

```bash
# Extension dependencies
grep -i "CREATE EXTENSION\|LOAD " *.sql migrations/*.sql | head -10

# Version-specific syntax (coupling to specific DB version)
grep -i "IF NOT EXISTS\|GENERATED ALWAYS\|LATERAL\|JSONB" *.sql | head -10
```

### Bash

```bash
# External tool dependencies
grep -rn "which \|command -v \|type " --include="*.sh" | head -20

# Package manager invocations (coupling to specific package managers)
grep -rn "apt\|brew\|yum\|dnf\|pacman\|pip\|npm\|go install" --include="*.sh" | head -20

# Version pinning in tool installs
grep -rn "install\|@\|==\|>=\|~=" --include="*.sh" | head -20
```

---

## Quick Checklist (all languages)

Run this first for a rapid pass/fail before deep analysis:

```bash
# Lock file exists?
ls package-lock.json yarn.lock pnpm-lock.yaml go.sum Cargo.lock 2>/dev/null

# CI configuration present?
ls .github/workflows/*.yml .gitlab-ci.yml Jenkinsfile Makefile justfile taskfile.yml 2>/dev/null

# Linter config present?
ls .eslintrc* biome.json .golangci.yml .pylintrc .shellcheckrc 2>/dev/null

# Test directory or test files exist?
find . -maxdepth 3 -name "*test*" -o -name "*spec*" | head -5

# README exists and is non-trivial?
wc -l README.md 2>/dev/null

# .gitignore covers build artifacts?
cat .gitignore 2>/dev/null | head -20

# No secrets in tracked files?
grep -rn "AKIA\|sk-\|ghp_\|password.*=.*['\"]" --include="*.ts" --include="*.go" --include="*.sh" --include="*.sql" | head -5
```
