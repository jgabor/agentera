import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatch } from "../lib/exec.mjs";
function mktmp(prefix = "shim-dispatch-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeAppHomeScript(home, content) {
  const scriptDir = path.join(home, "app", "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, "agentera");
  fs.writeFileSync(scriptPath, content);
  return scriptPath;
}

function writeRepoScript(repoRoot, content) {
  fs.mkdirSync(path.join(repoRoot, "scripts"), { recursive: true });
  const scriptPath = path.join(repoRoot, "scripts", "agentera");
  fs.writeFileSync(scriptPath, content);
  return scriptPath;
}

function writeFakeUv(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const uvPath = path.join(dir, "uv");
  const uvxPath = path.join(dir, "uvx");

  const logPath = opts.logPath ?? path.join(dir, "uv.log");
  const crashScriptPath = opts.crashScriptPath ?? "";
  const crashGuard = crashScriptPath
    ? `case "$2" in
  "${crashScriptPath}") exit 7 ;;
esac`
    : "";

  const body = `#!/bin/sh
echo "$0 $*" >> "${logPath}"
case "$0" in
  *uvx*) exit 99 ;;
esac
${crashGuard}
exit 0
`;
  fs.writeFileSync(uvPath, body);
  fs.chmodSync(uvPath, 0o755);
  fs.writeFileSync(uvxPath, body);
  fs.chmodSync(uvxPath, 0o755);
  return { logPath, uvPath, uvxPath };
}

function withPath(value, fn) {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

function captureStderr(fn) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buffer = "";
  process.stderr.write = (chunk, ...rest) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    return originalWrite(chunk, ...rest);
  };
  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return buffer;
}

test("dispatch returns 0 when app-home script succeeds", () => {
  const appHome = mktmp("shim-app-home-");
  const uvDir = mktmp("shim-uv-bin-");
  try {
    writeAppHomeScript(appHome, ["#!/usr/bin/env -S uv run --script", "# /// script", "# ///", "pass", ""].join("\n"));
    const { logPath } = writeFakeUv(uvDir);

    const code = withPath(uvDir, () =>
      dispatch(["node", "agentera", "prime"], {
        cwd: appHome,
        env: { AGENTERA_HOME: appHome },
      }),
    );

    assert.equal(code, 0);
    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /uv run .*agentera/);
  } finally {
    clean(appHome);
    clean(uvDir);
  }
});

test("dispatch falls through to repo when app-home spawns a runtime crash", () => {
  const appHome = mktmp("shim-app-home-");
  const repoRoot = mktmp("shim-repo-");
  const uvDir = mktmp("shim-uv-bin-");
  try {
    const appHomeScript = writeAppHomeScript(appHome, ["#!/usr/bin/env -S uv run --script", "# /// script", "# ///", "pass", ""].join("\n"));
    writeRepoScript(repoRoot, ["#!/usr/bin/env -S uv run --script", "# /// script", "# ///", "pass", ""].join("\n"));
    const { logPath } = writeFakeUv(uvDir, {
      crashScriptPath: appHomeScript,
    });

    const stderr = captureStderr(() => {
      const code = withPath(uvDir, () =>
        dispatch(["node", "agentera", "prime"], {
          cwd: repoRoot,
          env: { AGENTERA_HOME: appHome },
        }),
      );
      assert.equal(code, 0);
    });

    const log = fs.readFileSync(logPath, "utf8");
    const invocations = log.trim().split("\n").filter(Boolean);
    assert.equal(invocations.length, 2, `expected 2 invocations, got:\n${log}`);
    assert.match(invocations[0], new RegExp(`uv run .*${path.basename(appHomeScript)}`));
    assert.match(invocations[1], /uv run scripts\/agentera/);
    assert.match(stderr, /app-home backend crashed .* falling through to next resolution strategy/);
  } finally {
    clean(appHome);
    clean(repoRoot);
    clean(uvDir);
  }
});

test("dispatch prints install help when app-home crashes and no other backend is available", () => {
  const appHome = mktmp("shim-app-home-");
  try {
    writeAppHomeScript(appHome, ["#!/usr/bin/env -S uv run --script", "# /// script", "# ///", "pass", ""].join("\n"));

    const stderr = captureStderr(() => {
      const code = withPath("", () =>
        dispatch(["node", "agentera", "prime"], {
          cwd: appHome,
          env: { AGENTERA_HOME: appHome },
        }),
      );
      assert.notEqual(code, 0);
    });

    assert.match(stderr, /app-home backend crashed .* falling through to next resolution strategy/);
    assert.match(stderr, /upgrade --channel development --project "\$PWD" --dry-run/);
    assert.doesNotMatch(stderr, /npx skills add/);
  } finally {
    clean(appHome);
  }
});

test("dispatch returns the --version exit code without spawning", () => {
  const uvDir = mktmp("shim-uv-bin-");
  try {
    const { logPath } = writeFakeUv(uvDir);

    const stderr = captureStderr(() => {
      const code = withPath(uvDir, () =>
        dispatch(["node", "agentera", "--version"], {
          cwd: uvDir,
          env: {},
        }),
      );
      assert.equal(code, 0);
    });

    assert.equal(fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "", "");
    assert.doesNotMatch(stderr, /@next/, "--version must not emit the v3 hint");
  } finally {
    clean(uvDir);
  }
});

test("dispatch emits the v3 deprecation banner to stderr", () => {
  const tmp = mktmp("shim-no-backend-");
  try {
    const stderr = captureStderr(() => {
      const code = withPath("", () =>
        dispatch(["node", "agentera", "prime"], {
          cwd: tmp,
          env: { AGENTERA_HOME: undefined },
        }),
      );
      assert.notEqual(code, 0);
    });

    assert.match(stderr, /agentera 2\.x .* is in maintenance/);
    assert.match(stderr, /npx -y agentera@next prime/);
    assert.match(stderr, /AGENTERA_NO_V3_HINT=1/);
    assert.match(stderr, /upgrade --channel development --project "\$PWD" --dry-run/);
    assert.match(stderr, /upgrade --channel development --project "\$PWD" --yes/);
    assert.doesNotMatch(stderr, /npx skills add/);
  } finally {
    clean(tmp);
  }
});

test("dispatch suppresses the v3 banner when AGENTERA_NO_V3_HINT=1", () => {
  const tmp = mktmp("shim-no-backend-");
  const original = process.env.AGENTERA_NO_V3_HINT;
  process.env.AGENTERA_NO_V3_HINT = "1";
  try {
    const stderr = captureStderr(() => {
      const code = withPath("", () =>
        dispatch(["node", "agentera", "prime"], {
          cwd: tmp,
          env: { AGENTERA_HOME: undefined },
        }),
      );
      assert.notEqual(code, 0);
    });

    assert.doesNotMatch(stderr, /@next/, "suppression flag must hide the @next pointer");
    assert.doesNotMatch(stderr, /in maintenance/, "suppression flag must hide the banner");
    assert.match(stderr, /Stable 2\.x recovery from a clone/, "stable recovery path still prints");
    assert.doesNotMatch(stderr, /npx skills add/);
  } finally {
    if (original === undefined) {
      delete process.env.AGENTERA_NO_V3_HINT;
    } else {
      process.env.AGENTERA_NO_V3_HINT = original;
    }
    clean(tmp);
  }
});
