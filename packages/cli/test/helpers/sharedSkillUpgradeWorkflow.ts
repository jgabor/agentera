import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export interface SharedSkillUpgradeScope {
  home: string;
  app: string;
  project: string;
}
type Invocation = { code: number | null; out: string; err: string };

/** Reproduce the OpenCode -> canonical -> legacy target chain, without live hosts. */
export function runSharedSkillUpgradeWorkflow(root: string, current: string, invoke: (args: string[], scope: SharedSkillUpgradeScope) => Invocation) {
  const home = path.join(root, "home"),
    app = path.join(home, ".local/share/agentera"),
    project = path.join(root, "project");
  const canonical = path.join(home, ".agents/skills/agentera");
  const opencode = path.join(home, ".config/orca/opencode-hooks/shared/skills/agentera");
  const legacy = path.join(app, "skills/agentera");
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(path.join(project, "keep.txt"), "unchanged project");
  write(path.join(legacy, "SKILL.md"), "old installed skill");
  write(path.join(legacy, "protocol.yaml"), "unchanged runtime contracts");
  write(path.join(app, "private.txt"), "unchanged app data");
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.mkdirSync(path.dirname(opencode), { recursive: true });
  fs.symlinkSync(legacy, canonical);
  fs.symlinkSync(canonical, opencode);
  const snapshot = (at: string): unknown => {
    const stat = fs.lstatSync(at);
    return stat.isSymbolicLink()
      ? { link: fs.readlinkSync(at), inode: stat.ino }
      : stat.isDirectory()
        ? Object.fromEntries(
            fs
              .readdirSync(at)
              .sort()
              .map((name) => [name, snapshot(path.join(at, name))]),
          )
        : fs.readFileSync(at).toString("base64");
  };
  const original = snapshot(root),
    originalTarget = snapshot(legacy),
    originalProject = snapshot(project),
    originalOuter = snapshot(opencode);
  const events: Array<{ command: string; code: number | null; bytes: number; status: unknown }> = [];
  const run = (args: string[]) => {
    const result = invoke(args, { home, app, project });
    assert.ok(result.out, result.err);
    const payload = JSON.parse(result.out);
    events.push({
      command: args.join(" "),
      code: result.code,
      bytes: Buffer.byteLength(result.out),
      status: payload.status ?? payload.shared_skill?.status,
    });
    return { ...result, payload };
  };
  const prime = run(["prime"]);
  const status = run(["prime", "--context", "status"]);
  const doctor = run(["doctor"]);
  assert.equal(prime.code, 0);
  assert.equal(status.code, 0);
  assert.ok(Buffer.byteLength(prime.out) <= 12000);
  assert.ok(Buffer.byteLength(status.out) <= 22500);
  const offer = prime.payload.shared_skill.upgrade_offer;
  assert.equal(offer.question, "Agentera’s installed skill needs an update. Update it now? Your project files will not change.");
  assert.equal(offer.approval, "explicit_yes_only");
  assert.deepEqual(status.payload.shared_skill.upgrade_offer, offer);
  assert.deepEqual(doctor.payload.shared_skill.upgrade_offer, offer);
  assert.deepEqual(snapshot(root), original);
  assert.equal(fs.existsSync(path.join(app, ".agentera")), false);
  // Fixture paths contain no whitespace; consume the supplied operation, not a fabricated token.
  const command = offer.apply_command.split(" ");
  assert.deepEqual(command.slice(0, 3), ["npx", "-y", "agentera@next"]);
  const args: string[] = command.slice(3);
  assert.equal(run(args.filter((arg) => arg !== "--yes")).payload.status, "pending");
  const wrongScope = [...args];
  wrongScope[wrongScope.indexOf("--home") + 1] = path.join(root, "different-home");
  const refused = run(wrongScope);
  assert.equal(refused.code, 1);
  assert.equal(refused.payload.status, "non_success");
  assert.deepEqual(snapshot(root), original);
  const applied = run(args);
  assert.equal(applied.code, 0);
  assert.equal(applied.payload.status, "success");
  assert.ok(fs.lstatSync(canonical).isDirectory());
  for (const entry of [canonical, opencode]) {
    assert.deepEqual(fs.readdirSync(entry), ["SKILL.md"]);
    assert.ok(fs.lstatSync(path.join(entry, "SKILL.md")).isFile());
    assert.equal(fs.readFileSync(path.join(entry, "SKILL.md"), "utf8"), current);
  }
  assert.equal(fs.realpathSync(opencode), canonical);
  assert.deepEqual(snapshot(opencode), originalOuter);
  assert.deepEqual(snapshot(legacy), originalTarget);
  assert.deepEqual(snapshot(project), originalProject);
  assert.equal(fs.readFileSync(path.join(app, "private.txt"), "utf8"), "unchanged app data");
  const completed = snapshot(root);
  for (const args of [["prime"], ["prime", "--context", "status"], ["doctor"]]) {
    const checked = run(args);
    assert.equal(checked.payload.shared_skill.status, "pass");
    assert.equal(checked.payload.shared_skill.upgrade_offer, null);
  }
  assert.equal(run(command.slice(3)).payload.status, "noop");
  assert.deepEqual(snapshot(root), completed);
  return { result: "pass", events };
}
