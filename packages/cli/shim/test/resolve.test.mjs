import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectShebangContentMismatch,
  findAppHomeScript,
  resolveBackend,
} from "../lib/resolve.mjs";

function mktmp(prefix = "shim-resolve-") {
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

function withPath(value, fn) {
  const original = process.env.PATH;
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

test("detectShebangContentMismatch flags node shebang with python content", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env node",
      "def main():",
      "    print('hello')",
      "",
    ].join("\n"));
    assert.equal(
      detectShebangContentMismatch(scriptPath),
      "shebang=js content=python",
    );
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch flags python shebang with js content", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env -S uv run --script",
      "const x = require('foo');",
      "console.log(x);",
      "",
    ].join("\n"));
    assert.equal(
      detectShebangContentMismatch(scriptPath),
      "shebang=python content=js",
    );
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch accepts python shebang with PEP 723 metadata", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env -S uv run --script",
      "# /// script",
      "# requires-python = '>=3.11'",
      "# ///",
      "import sys",
      "def main():",
      "    print('hello')",
      "",
    ].join("\n"));
    assert.equal(detectShebangContentMismatch(scriptPath), null);
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch accepts python3 shebang with python content", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env python3",
      "import sys",
      "print('hello')",
      "",
    ].join("\n"));
    assert.equal(detectShebangContentMismatch(scriptPath), null);
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch accepts node shebang with js content", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env node",
      "const x = require('foo');",
      "console.log(x);",
      "",
    ].join("\n"));
    assert.equal(detectShebangContentMismatch(scriptPath), null);
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch returns null when file has no shebang", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, "console.log('no shebang');\n");
    assert.equal(detectShebangContentMismatch(scriptPath), null);
  } finally {
    clean(tmp);
  }
});

test("detectShebangContentMismatch returns null for unknown shebang (bash)", () => {
  const tmp = mktmp();
  try {
    const scriptPath = writeAppHomeScript(tmp, [
      "#!/usr/bin/env bash",
      "echo 'shell script'",
      "",
    ].join("\n"));
    assert.equal(detectShebangContentMismatch(scriptPath), null);
  } finally {
    clean(tmp);
  }
});

test("findAppHomeScript returns null when agenteraHome is undefined or empty", () => {
  assert.equal(findAppHomeScript(undefined), null);
  assert.equal(findAppHomeScript(""), null);
});

test("findAppHomeScript returns null when the script file is missing", () => {
  const tmp = mktmp();
  try {
    assert.equal(findAppHomeScript(tmp), null);
  } finally {
    clean(tmp);
  }
});

test("findAppHomeScript returns null and logs stderr when shebang/content mismatch", () => {
  const tmp = mktmp();
  try {
    writeAppHomeScript(tmp, [
      "#!/usr/bin/env node",
      "def main():",
      "    print('hi')",
      "",
    ].join("\n"));

    const messages = [];
    const scriptPath = findAppHomeScript(tmp, {
      logStderr: (msg) => messages.push(msg),
    });

    assert.equal(scriptPath, null);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0],
      /app-home backend unavailable: shebang\/content mismatch/,
    );
    assert.match(messages[0], /shebang=js content=python/);
  } finally {
    clean(tmp);
  }
});

test("findAppHomeScript returns the script path for a valid PEP 723 python script", () => {
  const tmp = mktmp();
  try {
    const written = writeAppHomeScript(tmp, [
      "#!/usr/bin/env -S uv run --script",
      "# /// script",
      "# requires-python = '>=3.11'",
      "# ///",
      "def main():",
      "    pass",
      "",
    ].join("\n"));

    const messages = [];
    const scriptPath = findAppHomeScript(tmp, {
      logStderr: (msg) => messages.push(msg),
    });

    assert.equal(scriptPath, written);
    assert.equal(messages.length, 0);
  } finally {
    clean(tmp);
  }
});

test("findAppHomeScript returns the script path for a valid node + js script", () => {
  const tmp = mktmp();
  try {
    const written = writeAppHomeScript(tmp, [
      "#!/usr/bin/env node",
      "console.log('hello');",
      "",
    ].join("\n"));

    const scriptPath = findAppHomeScript(tmp);
    assert.equal(scriptPath, written);
  } finally {
    clean(tmp);
  }
});

test("resolveBackend returns app-home when AGENTERA_HOME has a valid script", () => {
  const tmp = mktmp();
  try {
    writeAppHomeScript(tmp, [
      "#!/usr/bin/env -S uv run --script",
      "# /// script",
      "# ///",
      "import sys",
      "",
    ].join("\n"));

    const result = resolveBackend({
      cwd: tmp,
      env: { AGENTERA_HOME: tmp, PATH: "" },
    });
    assert.equal(result.kind, "app-home");
    assert.equal(result.scriptPath, path.join(tmp, "app", "scripts", "agentera"));
  } finally {
    clean(tmp);
  }
});

test("resolveBackend logs mismatch and returns repo when app-home is corrupt and repo is available", () => {
  const appHome = mktmp("shim-app-home-");
  const repoRoot = mktmp("shim-repo-");
  try {
    writeAppHomeScript(appHome, [
      "#!/usr/bin/env node",
      "def main():",
      "    print('corrupt')",
      "",
    ].join("\n"));
    writeRepoScript(repoRoot, [
      "#!/usr/bin/env -S uv run --script",
      "# /// script",
      "# ///",
      "pass",
      "",
    ].join("\n"));

    const messages = [];
    const result = resolveBackend({
      cwd: repoRoot,
      env: { AGENTERA_HOME: appHome, PATH: "/non-existent-uv-dir" },
      logStderr: (msg) => messages.push(msg),
    });

    assert.equal(result.kind, "repo");
    assert.equal(result.repoRoot, repoRoot);
    assert.equal(messages.length, 1);
    assert.match(
      messages[0],
      /app-home backend unavailable: shebang\/content mismatch/,
    );
  } finally {
    clean(appHome);
    clean(repoRoot);
  }
});

test("resolveBackend logs mismatch and returns uvx when app-home is corrupt and uv is on PATH", () => {
  const appHome = mktmp("shim-app-home-");
  const uvDir = mktmp("shim-uv-bin-");
  try {
    writeAppHomeScript(appHome, [
      "#!/usr/bin/env node",
      "def main():",
      "    print('corrupt')",
      "",
    ].join("\n"));
    const fakeUv = path.join(uvDir, "uv");
    fs.writeFileSync(fakeUv, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeUv, 0o755);

    const messages = [];
    const result = withPath(uvDir, () =>
      resolveBackend({
        cwd: appHome,
        env: { AGENTERA_HOME: appHome },
        logStderr: (msg) => messages.push(msg),
      }),
    );

    assert.equal(result.kind, "uvx");
    assert.equal(messages.length, 1);
    assert.match(
      messages[0],
      /app-home backend unavailable: shebang\/content mismatch/,
    );
  } finally {
    clean(appHome);
    clean(uvDir);
  }
});

test("resolveBackend with excludeAppHome skips app-home even when valid", () => {
  const appHome = mktmp("shim-app-home-");
  try {
    writeAppHomeScript(appHome, [
      "#!/usr/bin/env -S uv run --script",
      "# /// script",
      "# ///",
      "pass",
      "",
    ].join("\n"));

    const result = withPath("", () =>
      resolveBackend({
        cwd: appHome,
        env: { AGENTERA_HOME: appHome },
        excludeAppHome: true,
      }),
    );

    assert.notEqual(result.kind, "app-home");
    assert.equal(result.kind, "none");
    assert.match(result.reason, /uv is not on PATH/);
  } finally {
    clean(appHome);
  }
});

test("resolveBackend returns kind:none with install help when nothing is available", () => {
  const result = withPath("", () =>
    resolveBackend({
      cwd: "/tmp",
      env: { AGENTERA_HOME: undefined },
    }),
  );

  assert.equal(result.kind, "none");
  assert.match(
    result.reason,
    /no installed app, no repo checkout, and uv is not on PATH/,
  );
});