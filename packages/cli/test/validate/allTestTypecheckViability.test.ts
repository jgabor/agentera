import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { verifyEvidence } from "../../scripts/verify-all-test-typecheck-evidence.mjs";

type Manifest = {
  manifestSha256?: string;
  inputs: Record<string, string>;
  normalization: { canonicalizer: { sha256: string }; policy: Record<string, string> };
  rawGzipSha256: string;
  normalizedSha256: string;
};

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function rewriteManifest(directory: string, mutate: (manifest: Manifest) => void) {
  const file = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  mutate(manifest);
  delete manifest.manifestSha256;
  manifest.manifestSha256 = sha256(canonical(manifest));
  fs.writeFileSync(file, canonical(manifest));
  fs.writeFileSync(path.join(directory, "manifest.sha256"), `${manifest.manifestSha256}\n`);
}

function inCopy(run: (directory: string) => void) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-type-tamper-"));
  try {
    fs.cpSync(path.resolve("test/evidence/all-test-typecheck-replay"), temp, { recursive: true });
    run(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe("all-test typecheck viability evidence", () => {
  it("replays the isolated measurement and compiled classifications", () =>
    expect(verifyEvidence()).toEqual([]));

  for (const [name, mutate] of Object.entries({
    input: (dir: string) => fs.appendFileSync(path.join(dir, "package.json"), " "),
    config: (dir: string) => fs.appendFileSync(path.join(dir, "tsconfig.json"), " "),
    digest: (dir: string) =>
      fs.writeFileSync(path.join(dir, "manifest.sha256"), `${"0".repeat(64)}\n`),
    tool: (dir: string) => {
      const file = path.join(dir, "manifest.json");
      fs.writeFileSync(
        file,
        fs.readFileSync(file, "utf8").replace("vite-plus@0.3.0", "vite-plus@0.3.1"),
      );
    },
    source: (dir: string) => fs.appendFileSync(path.join(dir, "source-binding.json"), " "),
  })) {
    it(`fails closed on ${name} tampering`, () => {
      inCopy((directory) => {
        mutate(directory);
        expect(verifyEvidence({ directory, replay: false })).not.toEqual([]);
      });
    });
  }

  it("fails closed when valid raw gzip content is rebound but differs from normalized output", () => {
    inCopy((directory) => {
      const file = path.join(directory, "compiler.raw.json.gz");
      const raw = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
      raw.diagnostics.find(({ code }: { code: string }) =>
        /^typescript\(TS\d+\)$/.test(code),
      )!.message += " [tampered]";
      fs.writeFileSync(file, gzipSync(`${JSON.stringify(raw)}\n`));
      rewriteManifest(directory, (manifest) => {
        manifest.inputs["compiler.raw.json.gz"] = manifest.rawGzipSha256 = sha256(
          fs.readFileSync(file),
        );
      });
      expect(verifyEvidence({ directory, replay: false })).toEqual([
        "all-test typecheck replay: tracked raw compiler output mismatch",
      ]);
    });
  });

  it("fails closed when rebound normalized output differs from decoded raw output", () => {
    inCopy((directory) => {
      const file = path.join(directory, "compiler.normalized.json");
      const normalized = JSON.parse(fs.readFileSync(file, "utf8"));
      normalized.diagnostics[0].message += " [tampered]";
      fs.writeFileSync(file, canonical(normalized));
      rewriteManifest(directory, (manifest) => {
        manifest.inputs["compiler.normalized.json"] = manifest.normalizedSha256 = sha256(
          fs.readFileSync(file),
        );
      });
      expect(verifyEvidence({ directory, replay: false })).toEqual([
        "all-test typecheck replay: tracked raw compiler output mismatch",
      ]);
    });
  });

  it("fails closed when a rebound normalization policy is altered", () => {
    inCopy((directory) => {
      rewriteManifest(directory, (manifest) => {
        manifest.normalization.policy.ordering = "tampered";
      });
      expect(verifyEvidence({ directory, replay: false })).toEqual([
        "all-test typecheck replay: normalization policy mismatch",
      ]);
    });
  });

  it("fails closed when a rebound canonicalizer hash is altered", () => {
    inCopy((directory) => {
      rewriteManifest(directory, (manifest) => {
        manifest.normalization.canonicalizer.sha256 = "0".repeat(64);
      });
      expect(verifyEvidence({ directory, replay: false })).toEqual([
        "all-test typecheck replay: canonicalizer binding mismatch",
      ]);
    });
  });
});
