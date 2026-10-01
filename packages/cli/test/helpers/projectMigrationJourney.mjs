import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const migrationScenarios = [
  "yes",
  "decline",
  "silence",
  "source-drift",
  "project-drift",
  "scope-drift",
  "effect-drift",
  "permission-drift",
  "publication-permission",
  "sigkill-resume",
  "todo-checkpoint-resume",
  "bad-todo-checkpoint",
  "verification-failure",
  "inter-phase-drift",
  "fresh-approval-after-stale",
  "many-effects",
  "bad-checkpoint",
  "missing-approval",
  "inapplicable",
];
const approvalPath = ".agentera/migrations/project-upgrade.json";
function bytes(root) {
  const result = {};
  const walk = (relative) => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      if (name === ".git") continue;
      const child = path.join(relative, name),
        absolute = path.join(root, child),
        stat = fs.lstatSync(absolute);
      result[child] = `${stat.mode}:` + (stat.isSymbolicLink() ? `link:${fs.readlinkSync(absolute)}` : stat.isDirectory() ? "directory" : createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
      if (stat.isDirectory()) walk(child);
    }
  };
  walk("");
  return result;
}
function initialize(root, selected = ".") {
  for (const args of [
    ["init", "--quiet"],
    ["add", selected],
    ["-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "synthetic v2"],
  ]) {
    const child = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
  }
}
export function projectMigrationJourney(binary, fixture, scenario, baseEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-supported-project-migration-journey-"));
  const project = path.join(root, "selected project"),
    home = path.join(root, "synthetic home");
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  fs.cpSync(fixture, project, { recursive: true });
  if (scenario === "todo-checkpoint-resume" || scenario === "bad-todo-checkpoint") fs.writeFileSync(path.join(project, "TODO.md"), "# TODO\n\n## → Normal\n- [ ] Synthetic migration task\n");
  fs.mkdirSync(path.join(project, ".cursor"));
  if (scenario === "many-effects") {
    fs.mkdirSync(path.join(project, ".cursor/agents"));
    for (const name of ["dokumentera", "hej", "inspektera", "inspirera", "optimera", "orkestrera", "planera", "profilera", "realisera", "resonera", "visionera", "visualisera"]) fs.writeFileSync(path.join(project, `.cursor/agents/${name}.md`), "<!-- agentera: managed -->\nSynthetic retired agent\n");
  }
  fs.writeFileSync(
    path.join(project, ".cursor/hooks.json"),
    JSON.stringify({
      hooks: { stop: [{ command: "uv run ${AGENTERA_HOME}/hooks/session_stop.py" }] },
    }),
  );
  for (const [relative, content] of [
    [".agents/skills/agentera/SKILL.md", "retained shared skill"],
    ["agentera/profile.yaml", "private profile bytes"],
    ["agentera/history.json", "private history bytes"],
    [".config/opencode/settings.json", "unowned global settings"],
  ]) {
    const absolute = path.join(home, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  if (scenario === "yes")
    for (const [relative, content] of [
      ["agentera/app/scripts/agentera", "retired v2 launcher"],
      ["agentera/app/skills/agentera/SKILL.md", "legacy app skill"],
      ["agentera/app/registry.json", JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] })],
      ["agentera/app/.agentera-bundle.json", JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" })],
    ]) {
      const absolute = path.join(home, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
  initialize(project);
  const preload = path.join(root, "synthetic-fault.mjs");
  if (scenario === "verification-failure")
    fs.writeFileSync(
      preload,
      `import fs from "node:fs"; import path from "node:path"; const target = ${JSON.stringify(path.join(project, ".agentera/entities/progress/progress_cycle/zzzzzzzzzz.yaml"))}; const unlink = fs.unlinkSync; fs.unlinkSync = function(file) { const result = unlink.apply(this, arguments); if (String(file).endsWith("/hooks.json")) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "corrupt: ["); } return result; };`,
    );
  if (scenario === "todo-checkpoint-resume" || scenario === "bad-todo-checkpoint")
    fs.writeFileSync(preload, `import fs from "node:fs"; const rename = fs.renameSync; fs.renameSync = function(from, to) { const result = rename.apply(this, arguments); if (String(to).endsWith("/TODO.md")) process.kill(process.pid, "SIGKILL"); return result; };`);
  if (scenario === "inter-phase-drift")
    fs.writeFileSync(
      preload,
      `import fs from "node:fs"; const rmdir = fs.rmdirSync; let changed = false; fs.rmdirSync = function(directory) { const result = rmdir.apply(this, arguments); if (!changed && String(directory).endsWith("/.writer.lock") && fs.existsSync(${JSON.stringify(path.join(project, ".agentera/state-mode.yaml"))})) { changed = true; fs.appendFileSync(${JSON.stringify(path.join(project, ".agentera/progress.yaml"))}, "\\n# concurrent owner change\\n"); } return result; };`,
    );
  if (scenario === "fresh-approval-after-stale")
    fs.writeFileSync(preload, `import fs from "node:fs"; const mkdir = fs.mkdirSync; fs.mkdirSync = function(directory) { if (String(directory).endsWith("/.agentera/entities")) throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" }); return mkdir.apply(this, arguments); };`);
  const env = {
    ...process.env,
    ...baseEnv,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    AGENTERA_PROFILE: path.join(home, "absent-profile"),
    NODE_ENV: "test",
  };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE", "AGENTERA_HOME", "AGENTERA_APP_HOME", "AGENTERA_INSTALL_ROOT", "OPENCODE_CONFIG_DIR", "NODE_OPTIONS"]) delete env[name];
  const trace = [];
  let offeredCommand;
  const quote = (text) => `'${text.replaceAll("'", `'"'"'`)}'`;
  const run = (args, override = {}, cwd = project, offered = false) => {
    const command = offered ? "/bin/sh" : process.execPath;
    const argv = offered ? ["-c", "exec " + offeredCommand.replace(/^npx -y agentera@next /, `${quote(process.execPath)} ${quote(binary)} `)] : [binary, ...args];
    const child = spawnSync(command, argv, {
      cwd,
      env: { ...env, ...override },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(child.error, undefined, String(child.error));
    let json;
    if (child.stdout.trim()) json = args.includes("--help") ? { text: child.stdout } : JSON.parse(child.stdout);
    trace.push({
      args,
      offered,
      rc: child.status,
      signal: child.signal,
      json,
      stderr: child.stderr,
    });
    return { rc: child.status, signal: child.signal, json, stderr: child.stderr };
  };
  try {
    const globalBefore = bytes(home),
      before = bytes(project);
    const previewArgs = ["upgrade", "--project", project, "--channel", "development", "--dry-run", "--format", "json"];
    if (scenario === "publication-permission") {
      assert.notEqual(process.getuid?.(), 0, "permission regression must run without root DAC override");
      for (const relative of [".agentera/migrations", ".agentera/migrations/project-upgrade"]) {
        const directory = path.join(project, relative);
        fs.mkdirSync(directory, { recursive: true });
        fs.chmodSync(directory, 0o500);
        const denied = bytes(project);
        const projections = [
          run(previewArgs).json.migration_offer,
          run(["prime", "--format", "json"]).json.startup.state_cutover.migration_offer,
          run(["prime", "--context", "status", "--format", "json"]).json.capability_context.startup.state_cutover.migration_offer,
          run(["doctor", "--project", project, "--format", "json"]).json.current_health.project_state.migration_offer,
        ];
        assert.deepEqual(projections, [undefined, undefined, undefined, undefined], `${relative} mode 0500 must not produce a ready offer`);
        assert.deepEqual(bytes(project), denied, "read-only refusal must preserve bytes and modes");
        assert.deepEqual(bytes(home), globalBefore);
        fs.chmodSync(directory, 0o700); // Explicit fixture setup, never CLI repair.
        const writable = bytes(project);
        const ready = run(previewArgs).json.migration_offer;
        assert.equal(ready?.status, "ready");
        assert.equal(run(["prime", "--format", "json"]).json.startup.state_cutover.migration_offer.apply_command, ready.apply_command);
        assert.equal(run(["prime", "--context", "status", "--format", "json"]).json.capability_context.startup.state_cutover.migration_offer.apply_command, ready.apply_command);
        assert.equal(run(["doctor", "--project", project, "--format", "json"]).json.current_health.project_state.migration_offer.apply_command, ready.apply_command);
        assert.deepEqual(bytes(project), writable, "writable preview must preserve bytes and modes");
      }
      assert.deepEqual(bytes(home), globalBefore);
      return { scenario, trace };
    }
    const preview = run(previewArgs),
      offer = preview.json.migration_offer;
    offeredCommand = offer?.apply_command;
    assert.equal(offer?.status, "ready", JSON.stringify(preview));
    assert.equal(offer.project, project);
    assert.equal(offer.target, "v3");
    assert.match(offer.warning, /rollback.*return to v2/);
    assert.match(offer.loss, /removed without a migration backup/);
    assert.ok(offer.effects.some((effect) => effect.sources?.includes(".cursor/hooks.json")));
    assert.deepEqual(bytes(project), before, "preview must be zero-write");
    const prime = run(["prime", "--format", "json"]);
    assert.ok(prime.json?.startup, JSON.stringify(prime));
    assert.equal(prime.json.startup.state_cutover.migration_offer.apply_command, offer.apply_command);
    const startup = run(["prime", "--context", "status", "--format", "json"]);
    assert.ok(startup.json, JSON.stringify(startup));
    assert.equal(startup.json.capability_context.instruction_mode, "project_migration_offer");
    assert.equal(startup.json.capability_context.capability_instructions_deferred, true);
    assert.equal(startup.json.capability_context.startup.state_cutover.migration_offer.apply_command, offer.apply_command);
    const doctor = run(["doctor", "--project", project, "--format", "json"]);
    assert.equal(doctor.json.current_health.project_state.migration_offer.apply_command, offer.apply_command);
    assert.deepEqual(bytes(project), before, "startup preflight must be zero-write");
    if (scenario === "yes") {
      const fullStatus = run(["prime", "--context", "status", "--detail", "instructions", "--section", "instructions"]);
      assert.match(fullStatus.json.items.map((item) => item.content).join(""), /Dashboard rendering/);
      const details = run(["upgrade", "--explain", "--operation", "migrate", "--section", "usage"]);
      assert.match(details.json.items[0].content.offer, /unchanged complete apply_command/);
      const schema = run(["schema"]);
      assert.equal(schema.json.integration.project_migration.preview_field, "migration_offer");
      assert.match(run(["upgrade", "--help"]).json.text, /project-migration/);
      assert.deepEqual(bytes(project), before);
    }
    const apply = ["upgrade", "--project", project, "--channel", "development", "--yes", "--authorization", offer.apply_command.match(/--authorization (project-migration:[a-f0-9]{64})/)[1], "--format", "json"];
    if (scenario === "decline" || scenario === "silence") {
      // Cooperative host: no Yes means it never invokes the offered apply command.
      assert.deepEqual(bytes(project), before);
    } else if (["source-drift", "project-drift", "scope-drift", "effect-drift", "permission-drift"].includes(scenario)) {
      let command = apply;
      if (scenario === "source-drift") fs.appendFileSync(path.join(project, ".agentera/progress.yaml"), "\n# owner changed input\n");
      if (scenario === "effect-drift") fs.writeFileSync(path.join(project, ".cursor/hooks.json"), JSON.stringify({ command: "uv run ${AGENTERA_HOME}/hooks/another.py" }));
      if (scenario === "permission-drift") fs.chmodSync(path.join(project, ".agentera/progress.yaml"), 0o600);
      if (scenario === "scope-drift") command = [...apply, "--force"];
      if (scenario === "project-drift") {
        const other = path.join(root, "other project");
        fs.mkdirSync(other);
        fs.cpSync(fixture, other, { recursive: true });
        initialize(other);
        command = apply.map((item) => (item === project ? other : item));
      }
      const changed = bytes(project);
      const result = run(command);
      assert.equal(result.json?.error?.class, "stale_operation", JSON.stringify(result));
      assert.deepEqual(bytes(project), changed, "stale apply must make no new changes");
      if (scenario === "scope-drift")
        for (const flags of [["--install-root", path.join(home, "agentera")], ["--shared-skill", "--home", home], ["--legacy-cleanup", "cursor.agent.agentera"], ["--reset-product-v1"], ["--only", "artifacts"]]) {
          const refusal = run([...apply, ...flags]);
          assert.notEqual(refusal.rc, 0);
          // Reset/channel combinations are rejected by the established
          // argument contract before the operation reaches its binding check.
          assert.equal(refusal.json?.error?.class, flags[0] === "--reset-product-v1" ? "invalid_request" : "stale_operation", JSON.stringify({ flags, refusal }));
          assert.deepEqual(bytes(project), changed);
          assert.deepEqual(bytes(home), globalBefore);
        }
    } else if (scenario === "inapplicable") {
      for (const [name, setup] of [
        ["fresh", () => {}],
        ["partial", (target) => fs.writeFileSync(path.join(target, ".agentera/progress.yaml"), "cycles: []\n")],
        ["corrupt", (target) => fs.writeFileSync(path.join(target, ".agentera/progress.yaml"), "cycles: [unterminated")],
        ["unsupported", (target) => fs.writeFileSync(path.join(target, ".agentera/progress.yaml"), "schema_version: legacy-v1\nunsupported: true\n")],
        [
          "unsupported-todo",
          (target) => {
            fs.cpSync(fixture, target, { recursive: true });
            fs.writeFileSync(path.join(target, "TODO.md"), "# TODO\n\n## Normal\n- [ ] Synthetic malformed managed section\n");
          },
        ],
      ]) {
        const target = path.join(root, name);
        fs.mkdirSync(target);
        fs.mkdirSync(path.join(target, ".agentera"));
        setup(target);
        initialize(target);
        const targetBefore = bytes(target);
        assert.equal(run(previewArgs.map((item) => (item === project ? target : item))).json.migration_offer, undefined);
        assert.equal(run(["doctor", "--project", target, "--format", "json"]).json.current_health.project_state.migration_offer, undefined);
        assert.equal(run(["prime", "--format", "json"], {}, target).json.startup.state_cutover.migration_offer, undefined);
        assert.deepEqual(bytes(target), targetBefore);
      }
    } else {
      const result = run(
        apply,
        scenario === "sigkill-resume" || scenario === "bad-checkpoint" || scenario === "missing-approval"
          ? { AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE: "SIGKILL_entity_published" }
          : scenario === "fresh-approval-after-stale" || scenario === "inter-phase-drift" || scenario === "verification-failure" || scenario === "todo-checkpoint-resume" || scenario === "bad-todo-checkpoint"
            ? { NODE_OPTIONS: `--import=${preload}` }
            : {},
        project,
        true,
      );
      if (scenario === "fresh-approval-after-stale") {
        assert.notEqual(result.rc, 0);
        assert.notEqual(result.json?.status, "success");
        assert.ok(fs.existsSync(path.join(project, approvalPath)));
        assert.equal(fs.existsSync(path.join(project, ".agentera/state-mode.yaml")), false);
        fs.appendFileSync(path.join(project, ".agentera/progress.yaml"), "\n# explicit synthetic owner change\n");
        initialize(project, ".agentera/progress.yaml");
        const changed = bytes(project);
        assert.equal(run(apply, {}, project, true).json?.error?.class, "stale_operation");
        assert.deepEqual(bytes(project), changed);
        const fresh = run(previewArgs).json.migration_offer;
        assert.equal(fresh?.status, "ready");
        assert.notEqual(fresh.apply_command, offeredCommand);
        assert.deepEqual(bytes(project), changed, "fresh preview remains zero-write");
        offeredCommand = fresh.apply_command;
        apply[apply.indexOf("--authorization") + 1] = offeredCommand.match(/--authorization (project-migration:[a-f0-9]{64})/)[1];
        assert.equal(run(apply, {}, project, true).json?.status, "success");
      } else if (scenario === "inter-phase-drift") {
        assert.equal(result.rc, 1, JSON.stringify(result));
        assert.equal(result.json.error.class, "stale_operation");
        assert.ok(fs.existsSync(path.join(project, ".agentera/state-mode.yaml")));
        assert.ok(fs.existsSync(path.join(project, ".cursor/hooks.json")), "no retirement effects may follow unexpected inter-phase drift");
        assert.match(fs.readFileSync(path.join(project, ".agentera/progress.yaml"), "utf8"), /concurrent owner change/);
        const changed = bytes(project);
        assert.notEqual(run(apply, {}, project, true).rc, 0);
        assert.deepEqual(bytes(project), changed);
      } else if (scenario === "verification-failure") {
        assert.equal(result.rc, 1);
        assert.equal(result.json.status, "failed");
        assert.equal(result.json.phase, "verification", JSON.stringify(result));
        assert.equal(result.json.state_validation.status, "failed");
        assert.ok(fs.existsSync(path.join(project, ".agentera/state-mode.yaml")));
        assert.match(result.stderr, /continue forward/);
        const failed = bytes(project);
        assert.notEqual(run(apply, {}, project, true).rc, 0);
        assert.deepEqual(bytes(project), failed);
      } else if (scenario !== "yes" && scenario !== "many-effects") {
        assert.equal(result.signal, "SIGKILL");
        assert.ok(fs.existsSync(path.join(project, approvalPath)));
        if (scenario === "bad-checkpoint") fs.appendFileSync(path.join(project, approvalPath), "bad checkpoint");
        if (scenario === "bad-todo-checkpoint") {
          const directory = path.join(project, ".agentera/.todo-reconciliation");
          const journal = fs.readdirSync(directory).find((name) => name.endsWith(".json"));
          assert.ok(journal);
          fs.appendFileSync(path.join(directory, journal), "invalid checkpoint");
        }
        const interrupted = bytes(project);
        const resumed = run(scenario === "missing-approval" ? apply.filter((item, index) => item !== "--authorization" && apply[index - 1] !== "--authorization") : apply, {}, project, scenario !== "missing-approval");
        if (scenario === "bad-checkpoint" || scenario === "bad-todo-checkpoint" || scenario === "missing-approval") {
          assert.notEqual(resumed.rc, 0);
          assert.deepEqual(bytes(project), interrupted);
        } else assert.equal(resumed.json?.status, "success", JSON.stringify(resumed));
      } else {
        assert.equal(result.rc, 0, JSON.stringify(result));
        assert.equal(result.json.status, "success");
        assert.equal(result.json.state_validation.status, "passed");
        assert.equal(result.json.startup_validation.status, "passed");
        assert.equal(fs.existsSync(path.join(project, ".cursor/hooks.json")), false);
        assert.equal(run(previewArgs).json.migration_offer, undefined);
        assert.equal(run(["prime", "--context", "status", "--format", "json"]).json.capability_context.instruction_mode, undefined);
        const completed = bytes(project);
        assert.equal(run(apply, {}, project, true).json.status, "success");
        assert.deepEqual(bytes(project), completed, "verified retry is idempotent");
      }
    }
    assert.deepEqual(bytes(home), globalBefore, "project approval must not mutate global resources");
    return { scenario, trace };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
