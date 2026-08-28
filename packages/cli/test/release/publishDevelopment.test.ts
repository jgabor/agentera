import { describe, expect, it, vi } from "vitest";

import { publishDevelopmentTarball } from "../../scripts/publish-development.mjs";

const source = "a".repeat(40);
const integrity = "sha512-exact";
const options = { tarball: "/tmp/agentera.tgz", packageVersion: "3.0.0-dev.10", gitRef: source };
const validate = () => ({
  manifest: { name: "agentera", version: options.packageVersion, agentera: { gitRef: source } },
  integrity,
});

function dependencies(currentNext: string, published: { integrity?: string; source?: string }, token: string | null = null) {
  const values = [{ next: currentNext }, published.integrity ?? null, published.source ?? null];
  return { validate, view: vi.fn(() => values.shift()), run: vi.fn(), token };
}

describe("development publication", () => {
  it("publishes a new forward version with credentials only after registry inspection", () => {
    const deps = dependencies("3.0.0-dev.9", {}, "secret");
    publishDevelopmentTarball(options, deps);
    expect(deps.view).toHaveBeenCalledTimes(3);
    expect(deps.run).toHaveBeenCalledWith("npm", [
      "publish", options.tarball, "--access", "public", "--tag", "next", "--ignore-scripts",
    ], expect.any(Object));
  });

  it("retags an identical forward version but never a superseded version", () => {
    const exact = { integrity, source };
    const forward = dependencies("3.0.0-dev.9", exact, "secret");
    publishDevelopmentTarball(options, forward);
    expect(forward.run).toHaveBeenCalledWith(
      "npm", ["dist-tag", "add", "agentera@3.0.0-dev.10", "next"], expect.any(Object),
    );

    const superseded = dependencies("3.0.0-dev.11", exact);
    publishDevelopmentTarball(options, superseded);
    expect(superseded.run).not.toHaveBeenCalled();
  });

  it("converges exact reruns without credentials or mutation", () => {
    const deps = dependencies(options.packageVersion, { integrity, source });
    publishDevelopmentTarball(options, deps);
    expect(deps.view).toHaveBeenCalledTimes(3);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([
    ["conflict", options.packageVersion, { integrity, source: "b".repeat(40) }],
    ["malformed current tag", "not-a-version", {}],
  ])("fails %s after credential-free inspection and before mutation", (_label, currentNext, published) => {
    const deps = dependencies(currentNext, published);
    expect(() => publishDevelopmentTarball(options, deps)).toThrow();
    expect(deps.view).toHaveBeenCalledTimes(3);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("requires credentials only for a forward mutation", () => {
    const deps = dependencies("3.0.0-dev.9", {});
    expect(() => publishDevelopmentTarball(options, deps)).toThrow("NPM_TOKEN is required");
    expect(deps.view).toHaveBeenCalledTimes(3);
    expect(deps.run).not.toHaveBeenCalled();
  });
});
