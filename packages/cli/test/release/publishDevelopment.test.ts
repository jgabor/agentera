import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyDevelopmentTarball, mutateDevelopmentTarball, writeDevelopmentClassification } from "../../scripts/publish-development.mjs";

const source = "a".repeat(40);
const secret = "test-auth-material-that-must-not-leak";
const coordinatorEnvironment = { PATH: process.env.PATH ?? "", SAFE_VALUE: "preserved" };
const oidcEnvironment = {
  ...coordinatorEnvironment,
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/id-token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
};
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
      expect(environment).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_URL");
      expect(environment).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
      expect(environment).not.toHaveProperty("GITHUB_ACTIONS");
      expect(environment.NPM_CONFIG_USERCONFIG).toBeTruthy();
      expect(fs.readFileSync(environment.NPM_CONFIG_USERCONFIG!, "utf8")).not.toContain("_auth");
      return values.shift();
    }),
    run: vi.fn((_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => {}),
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
    environment: coordinatorEnvironment,
  });
  return { classification, dependencies };
}

describe("development publication", () => {
  it.each([
    ["forward-publish", "3.0.0-dev.9", {}],
    ["forward-retag", "3.0.0-dev.9", { integrity: "exact", source }],
    ["exact-replay", "3.0.0-dev.10", { integrity: "exact", source }],
    ["superseded-replay", "3.0.0-dev.11", { integrity: "exact", source }],
  ])("classifies %s with a credential-free parent and registry child", (outcome, currentNext, published) => {
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

  it("publishes through OIDC only after a forward-publish classification", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry("3.0.0-dev.9", {});
    mutation.run.mockImplementation((_command, args, { env }) => {
      expect(env.GITHUB_ACTIONS).toBe("true");
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(oidcEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL);
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(oidcEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
      expect(env).not.toHaveProperty("NPM_TOKEN");
      expect(env).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(fs.readFileSync(env.NPM_CONFIG_USERCONFIG, "utf8")).toBe("registry=https://registry.npmjs.org/\n");
      expect(args.join(" ")).not.toContain(secret);
    });
    mutateDevelopmentTarball(options, classification, {
      ...mutation,
      environment: oidcEnvironment,
    });
    expect(mutation.run).toHaveBeenCalledTimes(1);
    const args = mutation.run.mock.calls[0][1];
    expect(args[0]).toBe("publish");
  });

  it("fails closed when forward-retag would require npm dist-tag", () => {
    const { classification } = classify("3.0.0-dev.9", { integrity, source });
    const mutation = registry("3.0.0-dev.9", { integrity, source });
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: coordinatorEnvironment,
      }),
    ).toThrow("OIDC does not authorize npm dist-tag");
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each([
    ["exact-replay", "3.0.0-dev.10"],
    ["superseded-replay", "3.0.0-dev.11"],
  ])("never authorizes a mutation process for %s", (_outcome, currentNext) => {
    const { classification } = classify(currentNext, { integrity, source });
    const mutation = registry(currentNext, { integrity, source });
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: coordinatorEnvironment,
      }),
    ).toThrow("classification does not authorize npm mutation");
    expect(mutation.view).not.toHaveBeenCalled();
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each([
    ["exact replay", "3.0.0-dev.10"],
    ["superseded replay", "3.0.0-dev.11"],
  ])("converges after a registry race becomes %s", (_label, currentNext) => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry(currentNext, { integrity, source });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: coordinatorEnvironment,
      }),
    ).toContain("replay");
    expect(mutation.run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
    log.mockRestore();
  });

  it.each([
    ["conflict", "3.0.0-dev.10", { integrity: "sha512-other", source }],
    ["older absent", "3.0.0-dev.11", {}],
    ["older conflicting", "3.0.0-dev.11", { integrity: "sha512-other", source }],
    ["malformed current tag", "not-a-version", {}],
  ])("fails closed on %s during credential-free classification", (_label, currentNext, published) => {
    expect(() => classify(currentNext, published)).toThrow();
  });

  it("keeps @next on the newer sequential version when a stale run arrives", () => {
    const first = classify("3.0.0-dev.8", {});
    expect(first.classification.outcome).toBe("forward-publish");

    options.packageVersion = "3.0.0-dev.11";
    const second = classify("3.0.0-dev.10", {});
    expect(second.classification.outcome).toBe("forward-publish");

    options.packageVersion = "3.0.0-dev.10";
    const stale = classify("3.0.0-dev.11", { integrity, source });
    expect(stale.classification.outcome).toBe("superseded-replay");
    expect(() =>
      mutateDevelopmentTarball(options, stale.classification, {
        ...registry("3.0.0-dev.11", { integrity, source }),
        environment: coordinatorEnvironment,
      }),
    ).toThrow("classification does not authorize npm mutation");
  });

  it("retries a failed prior forward run without allocating a new version", () => {
    const prior = classify("3.0.0-dev.9", {});
    expect(prior.classification.outcome).toBe("forward-publish");
    const retry = classify("3.0.0-dev.9", {});
    expect(retry.classification).toEqual(prior.classification);
  });

  it("binds mutation to the classified tarball bytes", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    fs.appendFileSync(options.tarball, "changed");
    const mutation = registry("3.0.0-dev.9", {});
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: coordinatorEnvironment,
      }),
    ).toThrow("classification does not match the exact tarball, version, and git ref");
    expect(mutation.view).not.toHaveBeenCalled();
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "GITHUB_ACTIONS=true"],
    [{ ...oidcEnvironment, GITHUB_ACTIONS: "false" }, "GITHUB_ACTIONS=true"],
    [{ ...oidcEnvironment, ACTIONS_ID_TOKEN_REQUEST_URL: " " }, "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [{ ...oidcEnvironment, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, "ACTIONS_ID_TOKEN_REQUEST_TOKEN"],
  ])("rejects missing or malformed OIDC before npm mutation", (environment, message) => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry("3.0.0-dev.9", {});
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: { ...coordinatorEnvironment, ...environment },
      }),
    ).toThrow(message);
    expect(mutation.view).toHaveBeenCalledTimes(3);
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it.each(["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_CONFIG_USERCONFIG"])("rejects a coordinator parent carrying %s before race inspection", (key) => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry("3.0.0-dev.9", {});
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: { ...coordinatorEnvironment, [key]: secret },
      }),
    ).toThrow("coordinator environment contains npm credentials or auth configuration");
    expect(mutation.view).not.toHaveBeenCalled();
    expect(mutation.run).not.toHaveBeenCalled();
  });

  it("does not expose traditional credentials when the OIDC npm child fails", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    const mutation = registry("3.0.0-dev.9", {});
    mutation.run.mockImplementation(() => {
      throw new Error("npm child failed");
    });
    expect(() =>
      mutateDevelopmentTarball(options, classification, {
        ...mutation,
        environment: oidcEnvironment,
      }),
    ).toThrow("npm child failed");
    expect(JSON.stringify(mutation.run.mock.calls)).not.toContain(secret);
  });

  it("keeps auth material out of the exact classification file", () => {
    const { classification } = classify("3.0.0-dev.9", {});
    const classificationFile = path.join(root, "classification.json");
    writeDevelopmentClassification(classificationFile, classification);
    const persisted = fs.readFileSync(classificationFile, "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("auth");
    expect(fs.statSync(classificationFile).mode & 0o777).toBe(0o600);
  });
});
