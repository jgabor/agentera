#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { generateEntityMigrationApproval } from "../dist/state/entityMigrationApproval.js";

const [project, sourceFingerprint, previewDigest, output] = process.argv.slice(2);
if (!project || !sourceFingerprint || !previewDigest || !output) {
  process.stderr.write("usage: node packages/cli/scripts/generate-entity-migration-approval.mjs PROJECT SOURCE_FINGERPRINT PREVIEW_DIGEST OUTPUT\n");
  process.exit(2);
}
const absoluteOutput = path.resolve(output);
const approval = generateEntityMigrationApproval(path.resolve(project), sourceFingerprint, previewDigest);
fs.writeFileSync(absoluteOutput, `${JSON.stringify(approval, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${absoluteOutput}\n`);
