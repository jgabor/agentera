//go:build mage

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/magefile/mage/mg"
)

var allowedStartupRuntimes = map[string]bool{
	"claude-code":    true,
	"codex":          true,
	"github-copilot": true,
	"opencode":       true,
}

// Bench contains manual benchmark targets.
type Bench mg.Namespace

// StartupState runs the manual startup state-access benchmark.
//
// Default run:
//
//	mage bench:startupState
//
// The default run uses documented runtime-store defaults. To override runtime
// history sources, set explicit runtime stores:
//
//	AGENTERA_BENCH_RUNTIME_STORES=opencode=/absolute/path/to/opencode.db mage bench:startupState
//
// Optional inputs: AGENTERA_BENCH_SALT, AGENTERA_BENCH_PROJECT_ROOTS, and
// AGENTERA_BENCH_OUTPUT_DIR. Without AGENTERA_BENCH_OUTPUT_DIR, durable
// benchmark history is written under ${AGENTERA_HOME}/benchmarks/startup-state/.
func (Bench) StartupState() error {
	options, err := parseStartupBenchEnv()
	if err != nil {
		return err
	}

	workDir, err := os.MkdirTemp("", "agentera-startup-state-bench-*")
	if err != nil {
		return fmt.Errorf("create temporary output directory: %w", err)
	}
	defer os.RemoveAll(workDir)

	cmdArgs := []string{"run", "scripts/startup_analysis_contract.py", "--output-dir", workDir, "--salt", options.salt, "--persist-benchmark", "--since-previous-benchmark"}
	if options.benchmarkDir != "" {
		cmdArgs = append(cmdArgs, "--benchmark-dir", options.benchmarkDir)
	}
	for _, projectRoot := range options.projectRoots {
		cmdArgs = append(cmdArgs, "--project-root", projectRoot)
	}
	if len(options.runtimeStores) == 0 {
		cmdArgs = append(cmdArgs, "--default-runtime-stores")
	} else {
		for _, runtimeStore := range options.runtimeStores {
			cmdArgs = append(cmdArgs, "--runtime-store", runtimeStore)
		}
	}

	cmd := exec.Command("uv", cmdArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return cmd.Run()
}

type startupBenchOptions struct {
	runtimeStores []string
	projectRoots  []string
	benchmarkDir  string
	salt          string
}

func parseStartupBenchEnv() (startupBenchOptions, error) {
	var options startupBenchOptions
	runtimeStores := strings.TrimSpace(os.Getenv("AGENTERA_BENCH_RUNTIME_STORES"))
	if runtimeStores != "" {
		for _, value := range strings.Split(runtimeStores, ",") {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			if err := validateRuntimeStoreApproval(value); err != nil {
				return options, startupBenchUsage(err.Error())
			}
			options.runtimeStores = append(options.runtimeStores, value)
		}
	}
	options.salt = strings.TrimSpace(os.Getenv("AGENTERA_BENCH_SALT"))
	if options.salt == "" {
		generated, err := generatedBenchmarkSalt()
		if err != nil {
			return options, fmt.Errorf("generate benchmark redaction salt: %w", err)
		}
		options.salt = generated
	}
	if outputDir := strings.TrimSpace(os.Getenv("AGENTERA_BENCH_OUTPUT_DIR")); outputDir != "" {
		path, err := absolutePath(outputDir, "AGENTERA_BENCH_OUTPUT_DIR")
		if err != nil {
			return options, startupBenchUsage(err.Error())
		}
		options.benchmarkDir = path
	}
	if projectRoots := strings.TrimSpace(os.Getenv("AGENTERA_BENCH_PROJECT_ROOTS")); projectRoots != "" {
		for _, value := range filepath.SplitList(projectRoots) {
			path, err := absolutePath(value, "AGENTERA_BENCH_PROJECT_ROOTS")
			if err != nil {
				return options, startupBenchUsage(err.Error())
			}
			options.projectRoots = append(options.projectRoots, path)
		}
	}
	if len(options.projectRoots) == 0 {
		cwd, err := os.Getwd()
		if err != nil {
			return options, fmt.Errorf("resolve current project root: %w", err)
		}
		options.projectRoots = []string{cwd}
	}
	return options, nil
}

func generatedBenchmarkSalt() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func validateRuntimeStoreApproval(value string) error {
	runtime, path, ok := strings.Cut(value, "=")
	if !ok || runtime == "" || path == "" {
		return errors.New("runtime approval must use RUNTIME=/absolute/path")
	}
	if !allowedStartupRuntimes[runtime] {
		return fmt.Errorf("unsupported runtime %q; valid runtimes: claude-code, codex, github-copilot, opencode", runtime)
	}
	_, err := absolutePath(path, "runtime-store")
	return err
}

func absolutePath(value string, label string) (string, error) {
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("%s must be an absolute path: %s", label, value)
	}
	return filepath.Clean(value), nil
}

func startupBenchUsage(reason string) error {
	return fmt.Errorf(`%s

bench:startupState can run with no environment variables; that default run uses documented runtime-store defaults.
To override runtime history sources, set AGENTERA_BENCH_RUNTIME_STORES=RUNTIME=/absolute/path for each runtime store; separate multiple overrides with commas.
Valid runtimes: claude-code, codex, github-copilot, opencode.
Optional: AGENTERA_BENCH_SALT, AGENTERA_BENCH_PROJECT_ROOTS, and AGENTERA_BENCH_OUTPUT_DIR. Path options must use absolute paths. AGENTERA_BENCH_OUTPUT_DIR overrides the durable benchmark directory.
Example: AGENTERA_BENCH_RUNTIME_STORES=opencode=/tmp/fixture/opencode.db mage bench:startupState`, reason)
}
