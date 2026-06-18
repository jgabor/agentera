#!/usr/bin/env node
/**
 * Node probe invoked by the generated scripts/extract_corpus.py wrapper.
 * Loads the compiled TS parity snapshot from dist/.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distParity = path.join(pkgRoot, "dist/analytics/extractCorpus/extractCorpusParity.js");

function usage() {
  process.stderr.write("usage: extract-corpus-parity-probe.mjs --opencode <opencode.db>\n");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--opencode") usage();

const { opencodeParitySnapshot } = await import(pathToFileUrl(distParity));
const snapshot = opencodeParitySnapshot(args[1]);
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

function pathToFileUrl(p) {
  return new URL(`file://${p.split(path.sep).join("/")}`).href;
}
