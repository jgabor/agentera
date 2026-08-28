import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyDevelopmentTarball,
  mutateDevelopmentTarball,
} from "../../scripts/publish-development.mjs";

const source = "a".repeat(40);
let root: string;
let options: { tarball: string; packageVersion: string; gitRef: string };
let integrity: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-publish-development-test-"));
  const tarball = path.join(root, "agentera.tgz");
  fs.writeFileSync(tarball, "exact tarball bytes");
  integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
  options = { tarball, packageVersion: "3.0.0-dev.10", gitRef: source };
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function registry(currentNext: string, published: { integrity?: string; source?: string }) {
  const values = [{ next: currentNext }, published.integrity ?? null, published.source ?? null];
  return {
    view: vi.fn((_args: string[], environment: NodeJS.ProcessEnv) => {
      expect(environment).not.toHaveProperty("NPM_TOKEN");
      expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
      return values.shift();
    }),
    run: vi.fn((_command: string, _args: string[], _options: object) => {}),
  };
}

function classify(currentNext: string, published: { integrity?: string; source?: string }) {
  const dependencies = registry(currentNext, published);
  const classification = classifyDevelopmentTarball(options, {
    validate: () => ({
      manifest: { name: "agentera", version: options.packageVersion, agentera: { gitRef: source } },
      integrity,
    }),
    view: dependencies.view,
  });
  return { classification, dependencies };
}

describe("development publication", () => {
  it.each([
    ["forward-publish", "3.0.0-dev.9", {}],
    ["forward-retag", "3.0.0-dev.9", { integrity: "exact", source }],
    ["exact-replay", "3.0.0-dev.10", { integrity: "exact", source }],
    ["superseded-replay", "3.0.0-dev.11", { integrity: "exact", source }],
  ])("classifies %s without exposing inherited credentials to registry inspection", (outcome, currentNext, published) => {
    vi.stubEnv("NPM_TOKEN", "must-not-reach-classification-child");
    const exact = { ...published, ...(published.integrity ? { integrity } : {}) };
    const result = classify(currentNext, exact);
    expect(result.classification).toMatchObject({
      schemaVersion: "agentera.developmentPublicationClassification.v1",
      outcome,
      package: "agentera",
      version: options.packageVersion,
      gitRef: source,
      integrity,
    });
    expect(result.dependencies.view).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["forward-publish", {}, "publish"],
    ["forward-retag", { integrity: "exact", source }, "dist-tag"],
  ])("mutates only after a %s classification", (_outcome, published, expectedCommand) => {
    const exact = { ...published, ...(published.integrity ? { integrity } : {}) };
    const { classification } = classify("3.0.0-dev.9", exact);
    const mutation = registry("3.0.0-dev.9", exact);
    mutateDevelopmentTarball(options, classification, { ...mutation, token: "secret" });
    expect(mutation.run).toHaveBeenCalledTimes(1);
    const args = mutation.run.mock.calls[0][1];
    expect(args[0]).toBe(expectedCommand);
    if (expectedCommand === "dist-tag") expect(args[1]).toBe("add");
  });

  it.each([
    ["exact-replay", "3.0.0-dev.10"],
    ["superseded-replay", "3.0.0-dev.11"],
  ])("never authorizes a mutation process for %s", (_outcome, currentNext) => {
    const { classification } = classify(currentNext, { integrity, source });
    const mutation = registry(currentNext, { integrity, source });
    expect(() => mutateDevelopmentTarball(options, classification, { ...mutation, token: "secret" }))
      .toThrow("classification does not authorize npm mutation");
    expect(mutation.view).not.toHaveBeenCalled();
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each([
    ["exact replay", "3.0.0-dev.10"],
    ["superseded replay", "3.0.0-dev.11"],
  ])("converges after a registry race becomes %s", (_label, currentNext) => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry(currentNext, { integrity, source });
    expect(mutateDevelopmentTarball(options, classification, { ...mutation, token: "secret" }))
      .toContain("replay");
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each([
    ["conflict", "3.0.0-dev.10", { integrity: "sha512-other", source }],
    ["malformed current tag", "not-a-version", {}],
  ])("fails closed on %s during credential-free classification", (_label, currentNext, published) => {
    expect(() => classify(currentNext, published)).toThrow();
  });

  it("binds mutation to the classified tarball bytes", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    fs.appendFileSync(options.tarball, "changed");
    const mutation = registry("3.0.0-dev.9", {});
    expect(() => mutateDevelopmentTarball(options, classification, { ...mutation, token: "secret" }))
      .toThrow("classification does not match the exact tarball, version, and git ref");
    expect(mutation.view).not.toHaveBeenCalled();
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it("requires credentials only after a forward mutation recheck", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry("3.0.0-dev.9", {});
    expect(() => mutateDevelopmentTarball(options, classification, mutation)).toThrow("NPM_TOKEN is required");
    expect(mutation.view).toHaveBeenCalledTimes(3);
    expect(mutation.run).not.toHaveBeenCalled();
  });
});
