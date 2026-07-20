import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it, expect, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function entityProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-hook-cli-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(
    path.join(root, ".agentera", "state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  return root;
}

function markerAbsentProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-hook-legacy-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera/entities/progress/progress_cycle"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml"), "not: [valid\n");
  return root;
}

function seedProgress(root: string, what: string): void {
  const directory = path.join(root, ".agentera/entities/progress/progress_cycle");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), [
    "id: aaaaaaaaaa",
    "artifact: progress",
    "record:",
    "  timestamp: 2026-07-20 08:00",
    "  type: test",
    "  phase: build",
    `  what: ${what}`,
    "  context:",
    "    intent: hook binding",
    "",
  ].join("\n"));
}

const DENY_PAYLOAD = JSON.stringify({
  runtime: "opencode",
  hook_event_name: "tool.execute.before",
  cwd: "/tmp/hooktest",
  tool_input: {
    file_path: "/tmp/hooktest/TODO.md",
    content: "# TODO\n\njust some text\n",
  },
});

describe("agentera hook dispatch", () => {
  it("requires a hook name", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("required");
  });

  it("rejects an unknown hook name", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook", "bogus"], { err: (t) => (err += t), stdin: () => "" });
    expect(rc).toBe(2);
    expect(err).toContain("unknown hook 'bogus'");
  });

  it("validate-artifact reports violations to stderr and exits 2", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook", "validate-artifact"], {
      err: (t) => (err += t),
      stdin: () => DENY_PAYLOAD,
    });
    expect(rc).toBe(2);
    expect(err).toContain("missing severity sections");
  });

  it("dispatches all five supported hook names through the CLI contract", () => {
    const cwd = entityProject();
    const event = JSON.stringify({ cwd, workspace_roots: [cwd] });
    for (const name of ["session-start", "session-stop", "cursor-session-start"] as const) {
      let err = "";
      const rc = main(["node", "agentera", "hook", name], {
        err: (text) => { err += text; },
        out: () => {},
        stdin: () => event,
      });
      expect(rc, name).toBe(0);
      expect(err, name).not.toContain("unknown hook");
    }

    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(main(["node", "agentera", "hook", "cursor-pre-tool-use"], {
        stdin: () => DENY_PAYLOAD,
      })).toBe(0);
    } finally {
      spy.mockRestore();
    }

    let err = "";
    expect(main(["node", "agentera", "hook", "validate-artifact"], {
      err: (text) => { err += text; },
      stdin: () => DENY_PAYLOAD,
    })).toBe(2);
    expect(err).toContain("missing severity sections");
  });

  it("cursor-pre-tool-use denies an invalid write with exit 0", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const rc = main(["node", "agentera", "hook", "cursor-pre-tool-use"], { stdin: () => DENY_PAYLOAD });
      expect(rc).toBe(0);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"permission": "deny"');
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["session-start", "session-stop", "cursor-session-start"] as const)(
    "%s gates and handles the same payload-bound project after one stdin parse",
    (name) => {
      const payloadRoot = entityProject();
      const cwd = markerAbsentProject();
      seedProgress(payloadRoot, "payload-only-progress");
      const previous = process.cwd();
      let reads = 0;
      let out = "";
      let err = "";
      process.chdir(cwd);
      try {
        const rc = main(["node", "agentera", "hook", name], {
          stdin: () => { reads += 1; return JSON.stringify(name === "cursor-session-start" ? { workspace_roots: [payloadRoot] } : { cwd: payloadRoot }); },
          out: (text) => { out += text; },
          err: (text) => { err += text; },
        });
        expect(rc).toBe(0);
      } finally {
        process.chdir(previous);
      }
      expect(reads).toBe(1);
      expect(err).toBe("");
      if (name !== "session-stop") expect(out).toContain("payload-only-progress");
      expect(out).not.toContain("migration_required");
    },
  );

  it.each(["session-start", "session-stop", "cursor-session-start"] as const)(
    "%s rejects a marker-absent payload project from marker-active cwd before reads or effects",
    (name) => {
      const cwd = entityProject();
      const payloadRoot = markerAbsentProject();
      const target = path.join(payloadRoot, ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml");
      const before = fs.readFileSync(target);
      const previous = process.cwd();
      let reads = 0;
      let out = "";
      let err = "";
      process.chdir(cwd);
      try {
        const rc = main(["node", "agentera", "hook", name], {
          stdin: () => { reads += 1; return JSON.stringify(name === "cursor-session-start" ? { workspace_roots: [payloadRoot] } : { cwd: payloadRoot }); },
          out: (text) => { out += text; },
          err: (text) => { err += text; },
        });
        expect(rc).toBe(1);
      } finally {
        process.chdir(previous);
      }
      expect(reads).toBe(1);
      expect(out).toBe("");
      expect(err).toContain("completed entity-state cutover");
      expect(err).toContain(payloadRoot);
      expect(fs.readFileSync(target)).toEqual(before);
    },
  );

  it.each(["session-start", "session-stop", "cursor-session-start"] as const)(
    "%s preserves missing and malformed payload behavior without duplicate stdin reads",
    (name) => {
      const cwd = entityProject();
      const previous = process.cwd();
      process.chdir(cwd);
      const invoke = (raw: string) => {
        let reads = 0;
        let out = "";
        let err = "";
        const rc = main(["node", "agentera", "hook", name], {
          stdin: () => { reads += 1; return raw; },
          out: (text) => { out += text; },
          err: (text) => { err += text; },
        });
        return { rc, reads, out, err };
      };
    try {
        const missing = invoke("");
        const malformed = invoke("{not-json");
        expect(missing).toEqual(malformed);
        expect(missing.rc).toBe(0);
        expect(missing.reads).toBe(1);
        expect(missing.err).toBe("");
    } finally {
        process.chdir(previous);
    }
    },
  );
});

describe("agentera usage dispatch", () => {
  it("rejects an invalid --format with the four-question envelope", () => {
    let err = "";
    const rc = main(["node", "agentera", "usage", "--format", "xml"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unsupported usage format 'xml'");
    expect(err).toContain("valid formats: text, json");
  });

  it("rejects an unrecognized argument", () => {
    let err = "";
    const rc = main(["node", "agentera", "usage", "--bogus"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unrecognized arguments: --bogus");
  });
});

describe("agentera upgrade dispatch", () => {
  it("rejects --yes together with --dry-run", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--yes", "--dry-run"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("rejects an unrecognized argument", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--bogus"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("unrecognized arguments: --bogus");
  });

  it("rejects every retired runtime selector with shared-skill guidance", () => {
    for (const selector of ["claude", "cursor-agent", "cursor", "all"]) {
      let err = "";
      const rc = main(["node", "agentera", "upgrade", "--runtime", selector, "--dry-run"], {
        err: (t) => (err += t),
      });
      expect(rc).toBe(2);
      expect(err).toContain("~/.agents/skills/agentera");
      expect(err).toContain("Remove --runtime");
    }
  });

  it("rejects --opencode-config-dir with explicit guidance", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--opencode-config-dir", "/tmp/opencode", "--dry-run"], {
      err: (t) => (err += t),
    });
    expect(rc).toBe(2);
    expect(err).toContain("--opencode-config-dir is not yet supported");
  });

  it("rejects retired selectors before considering phase filters", () => {
    let err = "";
    const rc = main([
      "node", "agentera", "upgrade", "--runtime", "cursor", "--only", "runtime", "--dry-run",
    ], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("Remove --runtime");
  });

  it("rejects --update-packages with explicit guidance", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--update-packages", "--dry-run"], {
      err: (t) => (err += t),
    });
    expect(rc).toBe(2);
    expect(err).toContain("--update-packages is retired");
  });
});
