import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  developmentProjectionOwners,
  assertDevelopmentRuntimeSurface,
  bindDevelopmentInvocation,
  DEVELOPMENT_CHILD_ENV_ALLOWLIST,
  DEVELOPMENT_CHILD_PATH,
  DEVELOPMENT_RUNTIME_REQUIRED_FILES,
  DevelopmentInvocationError,
  projectEntityDevelopmentValue,
  projectGlossaryDevelopmentValue,
  projectRuntimeOperationExamples,
  projectRuntimeOperationRecovery,
  scrubDevelopmentChildEnvironment,
  type EntityProjectionField,
  type GlossaryProjectionOwner,
} from "../../src/core/developmentInvocation.js";
import {
  ENTITY_LIST_RUNTIME_FAMILIES,
  type EntityListRuntimeFamilyKey,
} from "../../src/state/entityListRuntimeRegistry.js";
import { runtimeOperationSpec, runtimeOperationSpecs } from "../../src/state/write/runtimeOperations.js";
import { commandText } from "../../src/upgrade/upgradeCommands.js";

function rejects(action: () => unknown): void {
  expect(action).toThrow(/invalid development command projection/);
}

describe("exact code-owned development invocation projection", () => {
  it("binds shell-quoted path characters to one local argv element", () => {
    const source = String.raw`npx -y agentera@next doctor --project '/tmp/a ; $() & '"'"'quote'"'"' [雪]' --format json`;
    const bound = bindDevelopmentInvocation({ owner: "doctor.runtime-proof", source }, source);
    expect(bound.argv).toEqual([
      "doctor",
      "--project",
      "/tmp/a ; $() & 'quote' [雪]",
      "--format",
      "json",
    ]);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.argv)).toBe(true);
  });

  it.each([["LF", "\n"], ["CR", "\r"]])(
    "binds a quoted %s path to one exact argv element",
    (_label, separator) => {
      const project = `/tmp/project${separator}one ; $() & 'quote'`;
      const source = commandText([
        "npx", "-y", "agentera@next", "doctor", "--project", project, "--format", "json",
      ]);
      const bound = bindDevelopmentInvocation({ owner: "doctor.quoted-path", source }, source);
      expect(bound.argv).toEqual(["doctor", "--project", project, "--format", "json"]);
    },
  );

  it.each([
    ["bare", "agentera prime --context status --format json", "wrong_channel"],
    ["stable", "npx -y agentera@latest prime --context status --format json", "wrong_channel"],
    ["missing exact flag", "npx -y agentera@next prime --context status", "not_exact"],
    ["reordered", "npx -y agentera@next prime --format json --context status", "not_exact"],
    ["wrapped", "env npx -y agentera@next prime --context status --format json", "wrong_channel"],
    ["split selector", "npx -y agentera @next prime --context status --format json", "wrong_channel"],
    ["nested", "npx -y agentera@next prime --context 'bash -c whoami' --format json", "not_exact"],
    ["composition", "npx -y agentera@next prime --context status --format json; whoami", "malformed"],
    ["substitution", "npx -y agentera@next prime --context $(whoami) --format json", "malformed"],
    ["unquoted newline", "npx -y agentera@next prime\n--context status --format json", "malformed"],
    ["unquoted carriage return", "npx -y agentera@next prime\r--context status --format json", "malformed"],
    ["continued newline", "npx -y agentera@next prime \\\n--context status --format json", "malformed"],
    ["malformed quote", "npx -y agentera@next prime --context 'status --format json", "malformed"],
  ])("rejects %s before a caller receives argv", (_id, candidate, classification) => {
    const source = "npx -y agentera@next prime --context status --format json";
    try {
      bindDevelopmentInvocation({ owner: "prime.status", source }, candidate);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DevelopmentInvocationError);
      expect((error as DevelopmentInvocationError).classification).toBe(classification);
    }
  });

  it("scrubs credentials, npm configuration, Node injection, and unreviewed Agentera variables", () => {
    const inherited = {
      HOME: "/unsafe/home",
      PATH: "/home/user/SHOULD_NOT_REACH_CHILD:/usr/bin:/bin",
      NPM_TOKEN: "secret",
      npm_config_registry: "https://example.invalid",
      NODE_OPTIONS: "--import=/tmp/inject.mjs",
      AGENTERA_HOME: "/unsafe/agentera",
      AGENTERA_UNSAFE_MARKER: "secret",
    };
    const env = scrubDevelopmentChildEnvironment(inherited, {
      HOME: "/isolated/home",
      AGENTERA_HOME: "/isolated/agentera",
    });
    expect(env).toEqual({ HOME: "/isolated/home", PATH: DEVELOPMENT_CHILD_PATH, AGENTERA_HOME: "/isolated/agentera" });
    expect(DEVELOPMENT_CHILD_ENV_ALLOWLIST).not.toContain("NODE_OPTIONS");
  });

  it("fails closed for every omitted constructed-runtime surface", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "development-runtime-surface-"));
    try {
      for (const relative of DEVELOPMENT_RUNTIME_REQUIRED_FILES) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, relative === "package.json"
          ? JSON.stringify({ bin: { agentera: "dist/bin/agentera.js" }, files: ["dist", "bundle"] })
          : "fixture\n");
      }
      fs.chmodSync(path.join(root, "dist/bin/agentera.js"), 0o755);
      expect(assertDevelopmentRuntimeSurface(root)).toBe(path.join(root, "dist/bin/agentera.js"));
      for (const relative of DEVELOPMENT_RUNTIME_REQUIRED_FILES) {
        const target = path.join(root, relative);
        const bytes = fs.readFileSync(target);
        fs.rmSync(target);
        expect(() => assertDevelopmentRuntimeSurface(root), relative).toThrow(/invalid_authority/);
        fs.writeFileSync(target, bytes);
        if (relative === "dist/bin/agentera.js") fs.chmodSync(target, 0o755);
      }
      expect(DEVELOPMENT_RUNTIME_REQUIRED_FILES).toHaveLength(8);
      expect(Object.isFrozen(DEVELOPMENT_RUNTIME_REQUIRED_FILES)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves approved arguments, quoting, prose, and inline delimiters while changing only the prefix", () => {
    const decisions = runtimeOperationSpec("decisions", "update")!;
    expect(projectRuntimeOperationExamples(
      decisions.projection.examples.map(({ source }) => source),
      "decisions",
      "update",
    )).toEqual([
      'agentera state decisions update --id qjtrmnpvka --satisfaction-state provisionally_satisfied --satisfaction-evidence "..." --format json',
    ]);

    const progress = runtimeOperationSpec("progress", "append")!;
    expect(projectRuntimeOperationRecovery(progress.projection.recovery.source, "progress", "append"))
      .toBe("Run `agentera state progress explain --verb append --format json` and correct the rejected field; no state was changed.");

    expect(projectGlossaryDevelopmentValue(
      "Use the Profile capability to repair or regenerate PROFILE.md, then retry `npx -y agentera@next report profile-grounding --format json`; no profile bytes were changed.",
      "profile_grounding.repair",
    )).toBe("Use the Profile capability to repair or regenerate PROFILE.md, then retry `agentera report profile-grounding --format json`; no profile bytes were changed.");
  });

  it.each([
    ["unknown", "npx -y agentera@next destroy --yes"],
    ["composition", "npx -y agentera@next state progress append --input progress.yaml --format json && printf x"],
    ["numeric redirect", "npx -y agentera@next state progress append --input progress.yaml --format json 2>err"],
    ["substitution", "npx -y agentera@next state progress append --input $(printf x) --format json"],
    ["wrong channel", "npx -y agentera@latest state progress append --input progress.yaml --format json"],
    ["unclosed quote", 'npx -y agentera@next state progress append --input "progress.yaml --format json'],
    ["sibling", "npx -y agentera@next state progress append --input progress.yaml --format json npx -y agentera@next prime"],
    ["force", "npx -y agentera@next state progress append --input progress.yaml --format json --force"],
    ["garbage", "npx -y agentera@next state progress append --input progress.yaml --format json garbage"],
    ["quoted operator", 'npx -y agentera@next state progress append --input progress.yaml --format json "&&"'],
    ["adjacent prefix", "xnpx -y agentera@next state progress append --input progress.yaml --format json"],
    ["adjacent suffix", "npx -y agentera@next state progress append --input progress.yaml --format jsonoops"],
    ["continuation", "npx -y agentera@next state progress append --input progress.yaml --format json " + "\\" + "\n--force"],
    ["wrong family", "npx -y agentera@next state decisions append --input progress.yaml --format json"],
    ["duplicate flag", "npx -y agentera@next state progress append --input progress.yaml --input other.yaml --format json"],
    ["omitted value", "npx -y agentera@next state progress append --input --format json"],
    ["extra positional", "npx -y agentera@next state progress append extra --input progress.yaml --format json"],
    ["option-like value", "npx -y agentera@next state progress append --input -- --format json"],
  ])("rejects a complete example mutation before projection: %s", (_label, value) => {
    rejects(() => projectRuntimeOperationExamples([value], "progress", "append"));
  });

  it("rejects audit-2 recovery boundary mutations and invalid code-owned value domains", () => {
    const progress = runtimeOperationSpec("progress", "append")!.projection.recovery.source;
    for (const value of [
      progress.replace(" --format json`", " --format json --force`"),
      progress.replace(" --format json`", " --format json garbage`"),
      progress.replace(" --format json`", ' --format json "&&"`'),
      progress.replace("state progress", 'state progress "status'),
      progress.replace("npx -y", "xnpx -y"),
      progress.replace(" --format json`", " --format jsonoops`"),
      progress.replace(" --format json`", " --format json " + "\\" + "\n--force`"),
    ]) rejects(() => projectRuntimeOperationRecovery(value, "progress", "append"));

    const status = runtimeOperationSpec("plan", "set-status")!.projection.examples[0].source;
    rejects(() => projectRuntimeOperationExamples([status.replace("--status complete", "--status retired")], "plan", "set-status"));
    rejects(() => projectRuntimeOperationExamples([status.replace("--format json", "--format invalid")], "plan", "set-status"));
    expect(projectRuntimeOperationExamples([status], "plan", "set-status"))
      .toEqual(["agentera state plan set-status --id qjtrmnpvka --status complete --format json"]);
  });

  it("does not expose mutable authority objects that callers can turn into allowlists", () => {
    const returned = runtimeOperationSpec("progress", "append")!;
    returned.projection.examples[0].source += " --force";
    expect(runtimeOperationSpec("progress", "append")!.projection.examples[0].source)
      .toBe("npx -y agentera@next state progress append --input progress.yaml --format json");
    expect(() => {
      (ENTITY_LIST_RUNTIME_FAMILIES[0].projection as { example: string }).example += " garbage";
    }).toThrow(TypeError);
  });

  it("enumerates and exercises every mutation, retrieval, glossary, schema, and help projection owner", () => {
    const owners = developmentProjectionOwners();
    expect(owners).toHaveLength(99);
    expect(owners.filter(({ family }) => family === "mutation")).toHaveLength(61);
    expect(owners.filter(({ family }) => family === "retrieval")).toHaveLength(33);
    expect(owners.filter(({ family }) => family === "glossary")).toHaveLength(5);
    expect(new Set(owners.map(({ owner }) => owner)).size).toBe(owners.length);
    expect(owners.every(({ runtime }) => !runtime.includes("npx -y agentera@next"))).toBe(true);
    expect(owners.every(({ consumers }) => consumers.includes("schema") || consumers.includes("runtime_contract"))).toBe(true);
    expect(owners.filter(({ source }) => source.split("npx -y agentera@next").length - 1 > 1)).toEqual([]);

    for (const spec of runtimeOperationSpecs()) {
      expect(projectRuntimeOperationRecovery(spec.projection.recovery.source, spec.artifact, spec.verb))
        .toBe(spec.projection.recovery.runtime);
      expect(projectRuntimeOperationExamples(spec.projection.examples.map(({ source }) => source), spec.artifact, spec.verb))
        .toEqual(spec.projection.examples.map(({ runtime }) => runtime));
      rejects(() => projectRuntimeOperationRecovery(`${spec.projection.recovery.source} oops`, spec.artifact, spec.verb));
      rejects(() => projectRuntimeOperationExamples(
        spec.projection.examples.map(({ source }, index) => index === 0 ? `${source} oops` : source),
        spec.artifact,
        spec.verb,
      ));
    }

    for (const family of ENTITY_LIST_RUNTIME_FAMILIES) {
      for (const field of ["list", "get", "example", "bareRecovery"] as EntityProjectionField[]) {
        const source = family.projection[field];
        if (typeof source !== "string") continue;
        expect(projectEntityDevelopmentValue(source, family.key as EntityListRuntimeFamilyKey, field))
          .toBe(source.replace("npx -y agentera@next", "agentera"));
        rejects(() => projectEntityDevelopmentValue(`${source} oops`, family.key as EntityListRuntimeFamilyKey, field));
      }
    }

    const glossaryOwners = owners.filter(({ family }) => family === "glossary");
    for (const owner of glossaryOwners) {
      const key = owner.owner.slice("glossary.".length) as GlossaryProjectionOwner;
      expect(projectGlossaryDevelopmentValue(owner.source, key)).toBe(owner.runtime);
      rejects(() => projectGlossaryDevelopmentValue(`${owner.source} oops`, key));
    }
  });
});
