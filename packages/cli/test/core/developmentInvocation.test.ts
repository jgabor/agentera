import { describe, expect, it } from "vitest";

import {
  developmentProjectionOwners,
  projectEntityDevelopmentValue,
  projectGlossaryDevelopmentValue,
  projectRuntimeOperationExamples,
  projectRuntimeOperationRecovery,
  type EntityProjectionField,
  type GlossaryProjectionOwner,
} from "../../src/core/developmentInvocation.js";
import {
  ENTITY_LIST_RUNTIME_FAMILIES,
  type EntityListRuntimeFamilyKey,
} from "../../src/state/entityListRuntimeRegistry.js";
import { runtimeOperationSpec, runtimeOperationSpecs } from "../../src/state/write/runtimeOperations.js";

function rejects(action: () => unknown): void {
  expect(action).toThrow(/invalid development command projection/);
}

describe("exact code-owned development invocation projection", () => {
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
    expect(owners).toHaveLength(88);
    expect(owners.filter(({ family }) => family === "mutation")).toHaveLength(50);
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
