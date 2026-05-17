// Smoke test for agentera.js: bootstrapCommands() at plugin init,
// lifecycle counter behavior, and shell.env injection (3 branches).
// Run from the repo root: node scripts/smoke_opencode_bootstrap.mjs

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "..", ".opencode", "plugins", "agentera.js");

let tmpdir = null;
const originalHome = process.env.HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
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
  process.env.XDG_DATA_HOME = path.join(tmpdir, ".local", "share");
  delete process.env.AGENTERA_HOME;
  delete process.env.PROFILERA_PROFILE_DIR;

  const moduleExports = await import(PLUGIN_PATH);
  const { Agentera } = moduleExports;
  assert(
    Object.keys(moduleExports).join(",") === "Agentera",
    "OpenCode plugin file must export only plugin functions"
  );
  const {
    bootstrapCommands,
    bootstrapAgents,
    bootstrapSkills,
    COMMAND_TEMPLATES,
    AGENTERA_VERSION,
    AGENTERA_AGENT_MARKER,
    REQUIRED_AGENT_NAMES,
    OPENCODE_SKILL_INSTALL_COMMAND,
    commandBootstrap,
    agentBootstrap,
    skillBootstrap,
    hasManagedMarker,
    hasManagedAgentMarker,
    resolveAgenteraAppHome,
    resolveDefaultAgenteraAppHome,
    resolveAgenteraHome,
    resolveOpencodeCommandsDir,
    resolveOpencodeAgentsDir,
    resolveOpencodeSkillsDir,
    writeSessionBookmark,
    isBareHejUserMessage,
    normalizeBareHejTransportText,
    routeBareHejMessage,
    BARE_HEJ_ROUTED_PROMPT,
    lifecycle,
  } = Agentera.__test;

  assert(typeof Agentera === "function", "plugin must expose the Agentera function for OpenCode");

  const commandNames = Object.keys(COMMAND_TEMPLATES);
  const commandsDir = resolveOpencodeCommandsDir();
  const agentsDir = resolveOpencodeAgentsDir();
  const skillsDir = resolveOpencodeSkillsDir();
  assert(commandsDir === path.join(tmpdir, "commands"), "resolveOpencodeCommandsDir should honor OPENCODE_CONFIG_DIR");
  assert(agentsDir === path.join(tmpdir, "agents"), "resolveOpencodeAgentsDir should honor OPENCODE_CONFIG_DIR");
  assert(skillsDir === path.join(tmpdir, "skills"), "resolveOpencodeSkillsDir should honor OPENCODE_CONFIG_DIR");

  // --- Test 0: Current app-home layout ---
  const documentedAppHome = resolveDefaultAgenteraAppHome();
  const documentedManagedApp = path.join(documentedAppHome, "app");
  const staleOldDefault = path.join(tmpdir, ".agents", "agentera");
  const staleLegacySkillSource = path.join(tmpdir, ".agents", "skills", "agentera");
  fs.mkdirSync(path.join(documentedManagedApp, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(documentedManagedApp, "scripts", "validate_capability.py"),
    "#!/usr/bin/env -S uv run --script\n"
  );
  fs.mkdirSync(path.join(staleOldDefault, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(staleOldDefault, "scripts", "agentera"), "#!/usr/bin/env bash\n");
  fs.mkdirSync(path.join(staleLegacySkillSource, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(staleLegacySkillSource, "scripts", "agentera"), "#!/usr/bin/env bash\n");
  assert(
    resolveAgenteraAppHome() === documentedAppHome,
    `resolveAgenteraAppHome should choose the platform app home, got ${resolveAgenteraAppHome()}`
  );
  assert(
    resolveAgenteraHome() === documentedManagedApp,
    `resolveAgenteraHome should resolve through app/ for current app homes, got ${resolveAgenteraHome()}`
  );

  // --- Test 1: Basic bootstrap (call directly, as legacy smoke did) ---
  bootstrapCommands();

  assert(fs.existsSync(commandsDir), "commands dir should exist after bootstrap");
  assert(commandNames.includes("agentera"), "agentera command should be present");
  assert(commandNames.includes("hej"), "legacy hej bridge command should be present");

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

  // --- Test 1b: Skill bootstrap repairs managed OpenCode skill symlinks ---
  const sourceSkillsDir = path.resolve(__dirname, "..", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const brokenAgentera = path.join(skillsDir, "agentera");
  fs.symlinkSync(path.join(tmpdir, "missing-agentera-cache", "skills", "agentera"), brokenAgentera, "dir");
  const skillRepair = bootstrapSkills();
  assert(
    skillRepair.repaired.includes("agentera"),
    "bootstrapSkills should report repaired managed broken symlink"
  );
  assert(
    fs.realpathSync(brokenAgentera) === path.join(sourceSkillsDir, "agentera"),
    "bootstrapSkills should repoint broken managed symlink to an installed Agentera skill"
  );
  assert(
    fs.existsSync(path.join(brokenAgentera, "SKILL.md")),
    "repaired managed skill path should resolve to SKILL.md"
  );

  // --- Test 1c: Skill bootstrap preserves user-owned skill directories ---
  const userOwnedAgentera = path.join(skillsDir, "agentera");
  fs.rmSync(userOwnedAgentera, { recursive: true, force: true });
  fs.mkdirSync(userOwnedAgentera, { recursive: true });
  fs.writeFileSync(path.join(userOwnedAgentera, "README.md"), "user skill\n");
  const userOwnedSkillReport = bootstrapSkills();
  assert(
    userOwnedSkillReport.skippedUserOwned.includes("agentera"),
    "bootstrapSkills should report skipped user-owned skill directory"
  );
  assert(
    fs.readFileSync(path.join(userOwnedAgentera, "README.md"), "utf8") === "user skill\n",
    "bootstrapSkills should preserve user-owned skill directory content"
  );
  assert(
    !fs.existsSync(path.join(userOwnedAgentera, "SKILL.md")),
    "bootstrapSkills should not turn a user-owned directory into an Agentera skill path"
  );

  // --- Test 1d: Agent descriptor bootstrap installs per-capability descriptors ---
  const agentReport = bootstrapAgents();
  assert(
    agentReport.restored.length === REQUIRED_AGENT_NAMES.length,
    "bootstrapAgents should restore all Agentera capability descriptors"
  );
  for (const name of REQUIRED_AGENT_NAMES) {
    const filePath = path.join(agentsDir, `${name}.md`);
    assert(fs.existsSync(filePath), `${name}.md should exist after agent descriptor bootstrap`);
    const descriptorText = fs.readFileSync(filePath, "utf8");
    assert(hasManagedAgentMarker(filePath), `${name}.md should contain the Agentera body marker`);
    assert(!descriptorText.includes("\nname:"), `${name}.md should rely on filename for agent name`);
    assert(!descriptorText.includes("agentera_managed:"), `${name}.md should not use custom frontmatter`);
    assert(descriptorText.includes("mode: subagent"), `${name}.md should declare documented subagent mode`);
    assert(descriptorText.includes(AGENTERA_AGENT_MARKER), `${name}.md should include the managed body marker`);
    assert(
      descriptorText.includes(`capabilities/${name}/prose.md`),
      `${name}.md should point to the capability prose source`
    );
  }
  assert(
    fs.readFileSync(path.join(agentsDir, ".agentera-version"), "utf8").trim() === AGENTERA_VERSION,
    "agent descriptor marker should equal AGENTERA_VERSION"
  );

  // --- Test 1d.1: Legacy managed agent descriptor frontmatter is migrated ---
  const legacyManagedAgent = path.join(agentsDir, "realisera.md");
  fs.writeFileSync(
    legacyManagedAgent,
    "---\nname: realisera\ndescription: stale realisera\nagentera_managed: true\n---\nLegacy managed descriptor.\n"
  );
  const legacyAgentReport = bootstrapAgents();
  assert(
    legacyAgentReport.refreshed.includes("realisera"),
    "bootstrapAgents should refresh legacy managed descriptor frontmatter"
  );
  const migratedAgentText = fs.readFileSync(legacyManagedAgent, "utf8");
  assert(!migratedAgentText.includes("agentera_managed:"), "migrated agent descriptor must remove custom frontmatter");
  assert(migratedAgentText.includes("mode: subagent"), "migrated agent descriptor must use documented subagent mode");
  assert(hasManagedAgentMarker(legacyManagedAgent), "migrated agent descriptor must use the body marker");

  // --- Test 1e: Agent descriptor bootstrap preserves user-owned collisions ---
  const userOwnedAgent = path.join(agentsDir, "realisera.md");
  const userOwnedAgentContent = "---\ndescription: custom realisera\n---\nUser-owned agent.\n";
  fs.writeFileSync(userOwnedAgent, userOwnedAgentContent);
  const userOwnedAgentReport = bootstrapAgents();
  assert(
    userOwnedAgentReport.skippedUserOwned.includes("realisera"),
    "bootstrapAgents should report skipped user-owned agent descriptor"
  );
  assert(
    fs.readFileSync(userOwnedAgent, "utf8") === userOwnedAgentContent,
    "bootstrapAgents should preserve user-owned agent descriptor content"
  );
  fs.rmSync(agentsDir, { recursive: true, force: true });

  // --- Test 1f: Missing universal Agentera skills report install command and create no unusable paths ---
  const isolatedPluginRoot = path.join(tmpdir, "isolated-plugin-root");
  const isolatedPluginPath = path.join(isolatedPluginRoot, ".opencode", "plugins", "agentera.js");
  fs.mkdirSync(path.dirname(isolatedPluginPath), { recursive: true });
  fs.copyFileSync(PLUGIN_PATH, isolatedPluginPath);
  const isolated = await import(`${pathToFileURL(isolatedPluginPath)}?missing-source=${Date.now()}`);
  const isolatedTest = isolated.Agentera.__test;
  fs.rmSync(skillsDir, { recursive: true, force: true });
  const missingSourceReport = isolatedTest.bootstrapSkills();
  assert(
    missingSourceReport.installCommand === OPENCODE_SKILL_INSTALL_COMMAND,
    "bootstrapSkills should report the exact OpenCode install command when Agentera skills are missing"
  );
  assert(
    !fs.existsSync(path.join(skillsDir, "agentera")),
    "bootstrapSkills must not create unusable skill paths when source skills are missing"
  );
  assert(
    isolatedTest.skillBootstrap.lastReport.installCommand === OPENCODE_SKILL_INSTALL_COMMAND,
    "skillBootstrap.lastReport should retain the missing-source install command"
  );
  const missingAgentReport = isolatedTest.bootstrapAgents();
  assert(
    missingAgentReport.missingSource.length === REQUIRED_AGENT_NAMES.length,
    "bootstrapAgents should report all missing descriptors when no Agentera source exists"
  );
  assert(
    isolatedTest.agentBootstrap.lastReport.missingSource.length === REQUIRED_AGENT_NAMES.length,
    "agentBootstrap.lastReport should retain missing descriptor names"
  );

  // --- Test 2: No-op on re-run with same version ---
  const agenteraPath = path.join(commandsDir, "agentera.md");
  const agenteraContentBefore = fs.readFileSync(agenteraPath, "utf8");
  bootstrapCommands();
  const agenteraContentAfter = fs.readFileSync(agenteraPath, "utf8");
  assert(agenteraContentBefore === agenteraContentAfter, "re-run with same version should be no-op (agentera.md unchanged)");
  assert(
    commandBootstrap.lastReport.unchanged.includes("agentera"),
    "same-version bootstrap report should include unchanged managed commands"
  );

  // --- Test 2b: Current marker with missing managed command repairs file ---
  fs.unlinkSync(agenteraPath);
  const missingRepair = bootstrapCommands();
  assert(
    missingRepair.restored.includes("agentera"),
    "current-marker bootstrap should report restored missing managed command"
  );
  assert(
    fs.readFileSync(agenteraPath, "utf8") === COMMAND_TEMPLATES["agentera"],
    "current-marker bootstrap should restore missing managed command template"
  );

  // --- Test 2c: Current marker with stale managed command refreshes file ---
  const staleCurrentMarkerContent = COMMAND_TEMPLATES["agentera"].replace(
    "bundled skill",
    "Stale current-marker managed command"
  );
  fs.writeFileSync(agenteraPath, staleCurrentMarkerContent);
  const staleRepair = bootstrapCommands();
  assert(
    staleRepair.refreshed.includes("agentera"),
    "current-marker bootstrap should report refreshed stale managed command"
  );
  assert(
    fs.readFileSync(agenteraPath, "utf8") === COMMAND_TEMPLATES["agentera"],
    "current-marker bootstrap should refresh stale managed command template"
  );

  // --- Test 2d: Current marker with user-owned command preserves and reports skip ---
  const userOwnedAgenteraCommand = "---\ndescription: user agentera\n---\nUser-owned command.\n";
  fs.writeFileSync(agenteraPath, userOwnedAgenteraCommand);
  const userOwnedReport = bootstrapCommands();
  assert(
    userOwnedReport.skippedUserOwned.includes("agentera"),
    "current-marker bootstrap should report skipped user-owned command collision"
  );
  assert(
    fs.readFileSync(agenteraPath, "utf8") === userOwnedAgenteraCommand,
    "current-marker bootstrap should preserve user-owned command collision"
  );
  fs.writeFileSync(agenteraPath, COMMAND_TEMPLATES["agentera"]);

  // --- Test 2e: Malformed managed marker is treated as user-owned ---
  const malformedManagedMarker = "---\nagentera_managed: true\nMalformed frontmatter without a closing marker.\n";
  fs.writeFileSync(agenteraPath, malformedManagedMarker);
  const malformedReport = bootstrapCommands();
  assert(
    !hasManagedMarker(agenteraPath),
    "malformed managed marker should not count as an Agentera-owned command"
  );
  assert(
    malformedReport.skippedUserOwned.includes("agentera"),
    "malformed managed marker should be reportable as a skipped user-owned collision"
  );
  assert(
    fs.readFileSync(agenteraPath, "utf8") === malformedManagedMarker,
    "malformed managed marker should not be overwritten"
  );
  fs.writeFileSync(agenteraPath, COMMAND_TEMPLATES["agentera"]);

  // --- Test 3: Collision test (user-owned file without managed marker) ---
  fs.unlinkSync(markerFile);
  const userContent = "---\ndescription: my custom agentera\n---\nMy custom agentera command.\n";
  fs.writeFileSync(agenteraPath, userContent);

  bootstrapCommands();

  const agenteraAfterCollision = fs.readFileSync(agenteraPath, "utf8");
  assert(
    agenteraAfterCollision === userContent,
    "user-owned agentera.md (no managed marker) should NOT be overwritten"
  );

  for (const name of commandNames) {
    if (name === "agentera") continue;
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
  fs.writeFileSync(agenteraPath, COMMAND_TEMPLATES["agentera"]);
  fs.writeFileSync(markerFile, "0.0.0");
  const staleContent = COMMAND_TEMPLATES["agentera"].replace(
    "bundled skill",
    "Stale managed command body"
  );
  assert(
    staleContent !== COMMAND_TEMPLATES["agentera"],
    "upgrade test setup should create stale managed content"
  );
  fs.writeFileSync(agenteraPath, staleContent);

  bootstrapCommands();

  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should be updated to AGENTERA_VERSION after upgrade"
  );
  assert(
    fs.readFileSync(agenteraPath, "utf8") === COMMAND_TEMPLATES["agentera"],
    "agentera.md should be refreshed to current managed content after upgrade"
  );

  // --- Test 5: Bootstrap-at-init via the Agentera plugin function ---
  // Wipe the commands dir to confirm calling Agentera() rebuilds it without
  // any explicit bootstrapCommands() call from the harness.
  fs.rmSync(commandsDir, { recursive: true, force: true });
  fs.rmSync(agentsDir, { recursive: true, force: true });
  const lifecycleCountBefore = lifecycle.initCount;
  const hooks1 = await Agentera({}, {});
  assert(typeof hooks1 === "object" && hooks1 !== null, "Agentera() must return a Hooks object");
  assert(lifecycle.initCount === lifecycleCountBefore + 1, "lifecycle.initCount should increment once per Agentera() call");
  assert(typeof lifecycle.lastInitAt === "string", "lifecycle.lastInitAt should be set");
  assert(fs.existsSync(commandsDir), "commands dir should be recreated by Agentera() init");
  assert(fs.existsSync(agentsDir), "agents dir should be recreated by Agentera() init");
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
  assert(
    agentBootstrap.lastReport.restored.includes("hej"),
    "Agentera() init should run agent descriptor bootstrap"
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
    hookKeys.includes("chat.message"),
    `Agentera() return must include chat.message hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    hookKeys.includes("tool.execute.after"),
    `Agentera() return must include tool.execute.after hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    hookKeys.includes("tool.execute.before"),
    `Agentera() return must include tool.execute.before hook (got: ${hookKeys.join(", ")})`
  );
  assert(
    !hookKeys.includes("session.created"),
    "Agentera() return must NOT include phantom session.created hook"
  );
  assert(
    !hookKeys.includes("session.idle"),
    "Agentera() return must NOT include phantom session.idle hook"
  );

  // --- Test 6b: OpenCode exact bare hej route ---
  const bareHejOutput = { parts: [{ type: "text", text: "hej" }] };
  assert(isBareHejUserMessage(bareHejOutput.parts), "bare lowercase hej should match the exact router predicate");
  assert(routeBareHejMessage(bareHejOutput), "routeBareHejMessage should rewrite exact bare hej");
  assert(
    bareHejOutput.parts[0].text === BARE_HEJ_ROUTED_PROMPT,
    "routeBareHejMessage should replace text with the Agentera routing prompt"
  );
  assert(
    bareHejOutput.parts[0].metadata.agenteraRoute === "bare-hej",
    "routeBareHejMessage should annotate the deterministic route"
  );
  assert(normalizeBareHejTransportText("hej\n") === "hej", "OpenCode CLI transport newline should normalize");
  const cliBareHejOutput = { parts: [{ type: "text", text: "hej\n" }] };
  assert(isBareHejUserMessage(cliBareHejOutput.parts), "OpenCode CLI bare hej should match with one transport newline");
  assert(routeBareHejMessage(cliBareHejOutput), "routeBareHejMessage should rewrite OpenCode CLI bare hej");
  for (const text of ["Hej", "hej there", "/hej", "agentera hej", " hej ", "hej\n\n", "hej \n"]) {
    const output = { parts: [{ type: "text", text }] };
    assert(!isBareHejUserMessage(output.parts), `${text} must not match exact bare hej routing`);
    assert(!routeBareHejMessage(output), `${text} must not be rewritten by exact bare hej routing`);
    assert(output.parts[0].text === text, `${text} should remain unchanged`);
  }
  assert(
    !isBareHejUserMessage([{ type: "text", text: "hej" }, { type: "file", filename: "note.md" }]),
    "bare hej routing must not fire when the user message has attachments or other meaningful parts"
  );

  // --- Test 7: Direct bookmark helper — missing hook script no-op ---
  const noHookProject = path.join(tmpdir, "no-hook-project");
  fs.mkdirSync(noHookProject, { recursive: true });
  writeSessionBookmark(noHookProject);
  assert(
    !fs.existsSync(path.join(noHookProject, ".agentera", "session.yaml")),
    "writeSessionBookmark must no-op when hooks/session_stop.py is unavailable"
  );

  // --- Test 8: event hook — idle writes session.yaml for modified artifacts ---
  const repoRoot = path.resolve(__dirname, "..");
  process.env.AGENTERA_HOME = repoRoot;
  const projectWithArtifact = path.join(tmpdir, "event-project");
  fs.mkdirSync(path.join(projectWithArtifact, ".agentera"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectWithArtifact });
  fs.writeFileSync(path.join(projectWithArtifact, "TODO.md"), "# TODO\n\n## \u21f6 Critical\n\n## \u21c9 Degraded\n\n## \u2192 Normal\n\n- [ ] event smoke\n\n## \u21e2 Annoying\n\n## Resolved\n");
  const hooksForEvents = await Agentera({ worktree: projectWithArtifact }, {});
  await hooksForEvents.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const sessionPath = path.join(projectWithArtifact, ".agentera", "session.yaml");
  assert(fs.existsSync(sessionPath), "session.idle event should write session.yaml when artifacts changed");
  const sessionText = fs.readFileSync(sessionPath, "utf8");
  assert(sessionText.includes("bookmarks:"), "session.yaml bookmark should include bookmarks list");
  assert(sessionText.includes("TODO.md"), "session.yaml bookmark should name modified TODO.md");

  // --- Test 8b: tool.execute.before hard gate — invalid empty artifact is denied ---
  let denied = false;
  try {
    await hooksForEvents["tool.execute.before"](
      { tool: "write", sessionID: "s1", callID: "deny-artifact" },
      {
        args: {
          filePath: ".agentera/session.yaml",
          content: "",
        },
      }
    );
  } catch (err) {
    denied = true;
    assert(
      String(err.message || err).includes("session"),
      "invalid artifact denial should include the artifact name"
    );
  }
  assert(denied, "tool.execute.before must deny invalid artifact candidates");

  // --- Test 8c: tool.execute.before hard gate — valid artifact is allowed ---
  await hooksForEvents["tool.execute.before"](
    { tool: "write", sessionID: "s1", callID: "allow-artifact" },
    {
      args: {
        filePath: ".agentera/session.yaml",
        content: "bookmarks:\n  - timestamp: \"2026-05-05 12:00\"\n    artifacts:\n      - TODO.md\n",
      },
    }
  );

  // --- Test 8d: tool.execute.before hard gate — non-artifact is a no-op ---
  await hooksForEvents["tool.execute.before"](
    { tool: "write", sessionID: "s1", callID: "noop-nonartifact" },
    {
      args: {
        filePath: "src/app.py",
        content: "print('not an artifact')\n",
      },
    }
  );

  // --- Test 9: event hook — created and malformed events do not bookmark ---
  const beforeCreated = fs.readFileSync(sessionPath, "utf8");
  await hooksForEvents.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
  await hooksForEvents.event({});
  assert(
    fs.readFileSync(sessionPath, "utf8") === beforeCreated,
    "session.created and malformed events must not write session.yaml bookmarks"
  );

  // --- Test 10: event hook — idle no-op without modified artifacts ---
  const cleanProject = path.join(tmpdir, "clean-event-project");
  fs.mkdirSync(cleanProject, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: cleanProject });
  const cleanHooks = await Agentera({ worktree: cleanProject }, {});
  await cleanHooks.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
  assert(
    !fs.existsSync(path.join(cleanProject, ".agentera", "session.yaml")),
    "session.idle event must not create session.yaml when no artifacts changed"
  );
  delete process.env.AGENTERA_HOME;

  // --- Test 11: shell.env injection — discoverable branch ---
  // Current app home exists with managed code under app/ (from Test 0).
  delete process.env.AGENTERA_HOME;
  const hooksDiscoverable = await Agentera({}, {});
  const envOut1 = { env: {} };
  await hooksDiscoverable["shell.env"]({ cwd: tmpdir }, envOut1);
  assert(
    envOut1.env.AGENTERA_HOME === documentedAppHome,
    `shell.env should inject the app home, got ${envOut1.env.AGENTERA_HOME}`
  );

  // --- Test 12: shell.env injection — not-discoverable branch ---
  // Move the marker script away so current app-home discovery returns null.
  const stagedScript = path.join(documentedManagedApp, "scripts", "validate_capability.py");
  const parkedScript = path.join(tmpdir, "_parked_validate_capability.py");
  fs.renameSync(stagedScript, parkedScript);
  delete process.env.AGENTERA_HOME;
  const hooksMissing = await Agentera({}, {});
  const envOut2 = { env: {} };
  await hooksMissing["shell.env"]({ cwd: tmpdir }, envOut2);
  assert(
    !("AGENTERA_HOME" in envOut2.env),
    "shell.env must leave AGENTERA_HOME unset (not empty string) when the app home is not discoverable"
  );
  // Restore for subsequent assertions.
  fs.renameSync(parkedScript, stagedScript);

  // --- Test 13: shell.env injection — user pre-set branch (process env) ---
  const userPreset = path.join(tmpdir, "user-chosen-root");
  fs.mkdirSync(path.join(userPreset, "app", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(userPreset, "app", "scripts", "validate_capability.py"), "#!/usr/bin/env -S uv run --script\n");
  process.env.AGENTERA_HOME = userPreset;
  const hooksPreset = await Agentera({}, {});
  const envOut3 = { env: {} };
  await hooksPreset["shell.env"]({ cwd: tmpdir }, envOut3);
  assert(
    envOut3.env.AGENTERA_HOME === userPreset,
    "shell.env must propagate a caller-selected AGENTERA_HOME when OpenCode has not already merged it"
  );
  delete process.env.AGENTERA_HOME;

  // --- Test 14: shell.env injection — pre-set branch (already in output env) ---
  const hooksAlreadyMerged = await Agentera({}, {});
  const alreadyMerged = path.join(tmpdir, "already-merged-root");
  fs.mkdirSync(path.join(alreadyMerged, "app", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(alreadyMerged, "app", "scripts", "validate_capability.py"), "#!/usr/bin/env -S uv run --script\n");
  const envOut4 = { env: { AGENTERA_HOME: alreadyMerged } };
  await hooksAlreadyMerged["shell.env"]({ cwd: tmpdir }, envOut4);
  assert(
    envOut4.env.AGENTERA_HOME === alreadyMerged,
    "shell.env must preserve a valid pre-merged AGENTERA_HOME value"
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
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
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
