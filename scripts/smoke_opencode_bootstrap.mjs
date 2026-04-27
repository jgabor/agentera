// Smoke test for agentera.js: bootstrapCommands() at plugin init,
// lifecycle counter behavior, and shell.env injection (3 branches).
// Run from the repo root: node scripts/smoke_opencode_bootstrap.mjs

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "..", ".opencode", "plugins", "agentera.js");

let tmpdir = null;
const originalHome = process.env.HOME;
const originalAgenteraHome = process.env.AGENTERA_HOME;
const originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalProfileDir = process.env.PROFILERA_PROFILE_DIR;

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

function assert(condition, reason) {
  if (!condition) fail(reason);
}

try {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-smoke-"));
  process.env.OPENCODE_CONFIG_DIR = tmpdir;
  process.env.HOME = tmpdir;
  delete process.env.AGENTERA_HOME;
  delete process.env.PROFILERA_PROFILE_DIR;

  const {
    Agentera,
    bootstrapCommands,
    COMMAND_TEMPLATES,
    AGENTERA_VERSION,
    hasManagedMarker,
    resolveAgenteraHome,
    resolveOpencodeCommandsDir,
    writeSessionBookmark,
    lifecycle,
  } = await import(PLUGIN_PATH);

  const commandNames = Object.keys(COMMAND_TEMPLATES);
  const commandsDir = resolveOpencodeCommandsDir();
  assert(commandsDir === path.join(tmpdir, "commands"), "resolveOpencodeCommandsDir should honor OPENCODE_CONFIG_DIR");

  // --- Test 0: Documented manual install root ---
  const documentedRoot = path.join(tmpdir, ".agents", "agentera");
  fs.mkdirSync(path.join(documentedRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(documentedRoot, "scripts", "validate_spec.py"), "#!/usr/bin/env python3\n");
  assert(
    resolveAgenteraHome() === documentedRoot,
    "resolveAgenteraHome should honor ~/.agents/agentera before legacy skills path"
  );

  // --- Test 1: Basic bootstrap (call directly, as legacy smoke did) ---
  bootstrapCommands();

  assert(fs.existsSync(commandsDir), "commands dir should exist after bootstrap");
  assert(commandNames.length === 12, `expected 12 commands, got ${commandNames.length}`);

  for (const name of commandNames) {
    const filePath = path.join(commandsDir, `${name}.md`);
    assert(fs.existsSync(filePath), `${name}.md should exist after bootstrap`);
    assert(
      hasManagedMarker(filePath),
      `${name}.md should contain agentera_managed: true in frontmatter`
    );
  }

  const markerFile = path.join(commandsDir, ".agentera-version");
  assert(fs.existsSync(markerFile), ".agentera-version marker should exist");
  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    `.agentera-version should equal AGENTERA_VERSION (${AGENTERA_VERSION})`
  );

  // --- Test 2: No-op on re-run with same version ---
  const hejPath = path.join(commandsDir, "hej.md");
  const hejContentBefore = fs.readFileSync(hejPath, "utf8");
  bootstrapCommands();
  const hejContentAfter = fs.readFileSync(hejPath, "utf8");
  assert(hejContentBefore === hejContentAfter, "re-run with same version should be no-op (hej.md unchanged)");

  // --- Test 3: Collision test (user-owned file without managed marker) ---
  fs.unlinkSync(markerFile);
  const userContent = "---\ndescription: my custom hej\n---\nMy custom hej command.\n";
  fs.writeFileSync(hejPath, userContent);

  bootstrapCommands();

  const hejAfterCollision = fs.readFileSync(hejPath, "utf8");
  assert(
    hejAfterCollision === userContent,
    "user-owned hej.md (no managed marker) should NOT be overwritten"
  );

  for (const name of commandNames) {
    if (name === "hej") continue;
    const filePath = path.join(commandsDir, `${name}.md`);
    assert(
      hasManagedMarker(filePath),
      `${name}.md should still contain agentera_managed: true after collision test`
    );
  }

  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should be refreshed after collision-test run"
  );

  // --- Test 4: Upgrade test (older version triggers refresh) ---
  fs.writeFileSync(markerFile, "0.0.0");
  const visioneraPath = path.join(commandsDir, "visionera.md");
  const staleContent = COMMAND_TEMPLATES["visionera"].replace(
    "Create or refine the project vision",
    "Stale managed command body"
  );
  assert(
    staleContent !== COMMAND_TEMPLATES["visionera"],
    "upgrade test setup should create stale managed content"
  );
  fs.writeFileSync(visioneraPath, staleContent);

  bootstrapCommands();

  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should be updated to AGENTERA_VERSION after upgrade"
  );
  assert(
    fs.readFileSync(visioneraPath, "utf8") === COMMAND_TEMPLATES["visionera"],
    "visionera.md should be refreshed to current managed content after upgrade"
  );

  assert(
    fs.readFileSync(hejPath, "utf8") === userContent,
    "user-owned hej.md should remain untouched after upgrade run"
  );

  // --- Test 5: Bootstrap-at-init via the Agentera plugin function ---
  // Wipe the commands dir to confirm calling Agentera() rebuilds it without
  // any explicit bootstrapCommands() call from the harness.
  fs.rmSync(commandsDir, { recursive: true, force: true });
  const lifecycleCountBefore = lifecycle.initCount;
  const hooks1 = await Agentera({}, {});
  assert(typeof hooks1 === "object" && hooks1 !== null, "Agentera() must return a Hooks object");
  assert(lifecycle.initCount === lifecycleCountBefore + 1, "lifecycle.initCount should increment once per Agentera() call");
  assert(typeof lifecycle.lastInitAt === "string", "lifecycle.lastInitAt should be set");
  assert(fs.existsSync(commandsDir), "commands dir should be recreated by Agentera() init");
  for (const name of commandNames) {
    assert(
      fs.existsSync(path.join(commandsDir, `${name}.md`)),
      `${name}.md should exist after Agentera() init`
    );
  }
  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should match AGENTERA_VERSION after Agentera() init"
  );

  // --- Test 6: Hook surface (real OpenCode interface keys only) ---
  const hookKeys = Object.keys(hooks1).sort();
  assert(
    hookKeys.includes("event"),
    `Agentera() return must include generic event hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    hookKeys.includes("shell.env"),
    `Agentera() return must include shell.env hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    hookKeys.includes("tool.execute.after"),
    `Agentera() return must include tool.execute.after hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    !hookKeys.includes("session.created"),
    "Agentera() return must NOT include phantom session.created hook"
  );
  assert(
    !hookKeys.includes("session.idle"),
    "Agentera() return must NOT include phantom session.idle hook"
  );

  // --- Test 7: Direct bookmark helper — missing hook script no-op ---
  const noHookProject = path.join(tmpdir, "no-hook-project");
  fs.mkdirSync(noHookProject, { recursive: true });
  writeSessionBookmark(noHookProject);
  assert(
    !fs.existsSync(path.join(noHookProject, ".agentera", "SESSION.md")),
    "writeSessionBookmark must no-op when hooks/session_stop.py is unavailable"
  );

  // --- Test 8: event hook — idle writes SESSION.md for modified artifacts ---
  const repoRoot = path.resolve(__dirname, "..");
  process.env.AGENTERA_HOME = repoRoot;
  const projectWithArtifact = path.join(tmpdir, "event-project");
  fs.mkdirSync(path.join(projectWithArtifact, ".agentera"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectWithArtifact });
  fs.writeFileSync(path.join(projectWithArtifact, "TODO.md"), "# TODO\n\n## \u21f6 Critical\n\n## \u21c9 Degraded\n\n## \u2192 Normal\n\n- [ ] event smoke\n\n## \u21e2 Annoying\n\n## Resolved\n");
  const hooksForEvents = await Agentera({ worktree: projectWithArtifact }, {});
  await hooksForEvents.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const sessionPath = path.join(projectWithArtifact, ".agentera", "SESSION.md");
  assert(fs.existsSync(sessionPath), "session.idle event should write SESSION.md when artifacts changed");
  const sessionText = fs.readFileSync(sessionPath, "utf8");
  assert(sessionText.includes("Artifacts modified:"), "SESSION.md bookmark should include modified artifact summary");
  assert(sessionText.includes("TODO.md"), "SESSION.md bookmark should name modified TODO.md");

  // --- Test 9: event hook — created and malformed events do not bookmark ---
  const beforeCreated = fs.readFileSync(sessionPath, "utf8");
  await hooksForEvents.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
  await hooksForEvents.event({});
  assert(
    fs.readFileSync(sessionPath, "utf8") === beforeCreated,
    "session.created and malformed events must not write SESSION.md bookmarks"
  );

  // --- Test 10: event hook — idle no-op without modified artifacts ---
  const cleanProject = path.join(tmpdir, "clean-event-project");
  fs.mkdirSync(cleanProject, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: cleanProject });
  const cleanHooks = await Agentera({ worktree: cleanProject }, {});
  await cleanHooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
  assert(
    !fs.existsSync(path.join(cleanProject, ".agentera", "SESSION.md")),
    "session.idle event must not create SESSION.md when no artifacts changed"
  );
  delete process.env.AGENTERA_HOME;

  // --- Test 11: shell.env injection — discoverable branch ---
  // Documented install root exists at ~/.agents/agentera (from Test 0).
  delete process.env.AGENTERA_HOME;
  const hooksDiscoverable = await Agentera({}, {});
  const envOut1 = { env: {} };
  await hooksDiscoverable["shell.env"]({ cwd: tmpdir }, envOut1);
  assert(
    envOut1.env.AGENTERA_HOME === documentedRoot,
    `shell.env should inject documented install root, got ${envOut1.env.AGENTERA_HOME}`
  );

  // --- Test 12: shell.env injection — not-discoverable branch ---
  // Move the marker script away so resolveAgenteraHome returns null.
  const stagedScript = path.join(documentedRoot, "scripts", "validate_spec.py");
  const parkedScript = path.join(tmpdir, "_parked_validate_spec.py");
  fs.renameSync(stagedScript, parkedScript);
  delete process.env.AGENTERA_HOME;
  const hooksMissing = await Agentera({}, {});
  const envOut2 = { env: {} };
  await hooksMissing["shell.env"]({ cwd: tmpdir }, envOut2);
  assert(
    !("AGENTERA_HOME" in envOut2.env),
    "shell.env must leave AGENTERA_HOME unset (not empty string) when install root is not discoverable"
  );
  // Restore for subsequent assertions.
  fs.renameSync(parkedScript, stagedScript);

  // --- Test 13: shell.env injection — user pre-set branch (process env) ---
  const userPreset = path.join(tmpdir, "user-chosen-root");
  process.env.AGENTERA_HOME = userPreset;
  const hooksPreset = await Agentera({}, {});
  const envOut3 = { env: {} };
  await hooksPreset["shell.env"]({ cwd: tmpdir }, envOut3);
  assert(
    !("AGENTERA_HOME" in envOut3.env),
    "shell.env must not overwrite a pre-existing AGENTERA_HOME (process.env): user value already inherited downstream"
  );
  delete process.env.AGENTERA_HOME;

  // --- Test 14: shell.env injection — pre-set branch (already in output env) ---
  const hooksAlreadyMerged = await Agentera({}, {});
  const envOut4 = { env: { AGENTERA_HOME: "/already/merged/by/opencode" } };
  await hooksAlreadyMerged["shell.env"]({ cwd: tmpdir }, envOut4);
  assert(
    envOut4.env.AGENTERA_HOME === "/already/merged/by/opencode",
    "shell.env must preserve a pre-merged AGENTERA_HOME value"
  );

  // --- Test 15: Lifecycle counter monotonicity ---
  // initCount should now reflect every Agentera() call: Test 5, 8, 10, 11, 12, 13, 14.
  // (At least 5 calls; exact value depends on Test 5 baseline.)
  assert(
    lifecycle.initCount === lifecycleCountBefore + 7,
    `lifecycle.initCount expected to be ${lifecycleCountBefore + 7}, got ${lifecycle.initCount}`
  );
  console.error(
    `[smoke] lifecycle observation: Agentera() fired ${lifecycle.initCount - lifecycleCountBefore} time(s) ` +
    `across this harness; last init at ${lifecycle.lastInitAt}`
  );

  console.log("PASS: all smoke checks passed");
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = originalAgenteraHome;
  if (originalOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir;
  if (originalProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = originalProfileDir;
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}
