// Smoke test for agentera.js bootstrapCommands()
// Run from the repo root: node scripts/smoke_opencode_bootstrap.mjs

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "..", ".opencode", "plugins", "agentera.js");

let tmpdir = null;

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

  const { bootstrapCommands, COMMAND_TEMPLATES, AGENTERA_VERSION, hasManagedMarker, resolveOpencodeCommandsDir } =
    await import(PLUGIN_PATH);

  const commandNames = Object.keys(COMMAND_TEMPLATES);
  const commandsDir = resolveOpencodeCommandsDir();
  assert(commandsDir === path.join(tmpdir, "commands"), "resolveOpencodeCommandsDir should honor OPENCODE_CONFIG_DIR");

  // --- Test 1: Basic bootstrap ---
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
  // Touch the file to change mtime — bootstrap should be a no-op
  bootstrapCommands();
  const hejContentAfter = fs.readFileSync(hejPath, "utf8");
  assert(hejContentBefore === hejContentAfter, "re-run with same version should be no-op (hej.md unchanged)");

  // --- Test 3: Collision test (user-owned file without managed marker) ---
  // Remove marker to force re-run
  fs.unlinkSync(markerFile);
  const userContent = "---\ndescription: my custom hej\n---\nMy custom hej command.\n";
  fs.writeFileSync(hejPath, userContent);

  bootstrapCommands();

  const hejAfterCollision = fs.readFileSync(hejPath, "utf8");
  assert(
    hejAfterCollision === userContent,
    "user-owned hej.md (no managed marker) should NOT be overwritten"
  );

  // All other 11 commands should have been refreshed (marker absent means bootstrap ran)
  for (const name of commandNames) {
    if (name === "hej") continue;
    const filePath = path.join(commandsDir, `${name}.md`);
    assert(
      hasManagedMarker(filePath),
      `${name}.md should still contain agentera_managed: true after collision test`
    );
  }

  // Marker should now be written again
  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should be refreshed after collision-test run"
  );

  // --- Test 4: Upgrade test (older version triggers refresh) ---
  fs.writeFileSync(markerFile, "0.0.0");
  // Overwrite visionera.md with managed content to confirm it gets refreshed
  const visioneraPath = path.join(commandsDir, "visionera.md");
  const staleContent = COMMAND_TEMPLATES["visionera"].replace(AGENTERA_VERSION, "0.0.0-stale");
  fs.writeFileSync(visioneraPath, staleContent);

  bootstrapCommands();

  assert(
    fs.readFileSync(markerFile, "utf8").trim() === AGENTERA_VERSION,
    ".agentera-version should be updated to AGENTERA_VERSION after upgrade"
  );
  assert(
    hasManagedMarker(visioneraPath),
    "visionera.md should be refreshed and contain managed marker after upgrade"
  );

  // hej.md (user-owned) should still be user content
  assert(
    fs.readFileSync(hejPath, "utf8") === userContent,
    "user-owned hej.md should remain untouched after upgrade run"
  );

  console.log("PASS: all smoke checks passed");
} finally {
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
}
