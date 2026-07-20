#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = import.meta.dirname;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 1000) / 1000;
const sources = [];
const assertionsByIdentity = new Map();

for (let sample = 1; sample <= 3; sample += 1) {
  const report = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(root, `source-${sample}.json.gz`))),
  );
  const assertions = report.testResults.flatMap((file) =>
    file.assertionResults.map((assertion) => ({
      file: file.name.split("/packages/cli/").at(-1),
      name: assertion.fullName,
      duration_ms: assertion.duration ?? 0,
    })),
  );
  const jsonElapsedMs =
    Math.max(...report.testResults.map((file) => file.endTime)) - report.startTime;
  sources.push({
    sample,
    files: report.testResults.length,
    tests: report.numTotalTests,
    cumulative_assertion_ms: round(
      assertions.reduce((total, assertion) => total + assertion.duration_ms, 0),
    ),
    json_elapsed_ms: round(jsonElapsedMs),
  });
  for (const assertion of assertions) {
    const identity = `${assertion.file}\n${assertion.name}`;
    const entry = assertionsByIdentity.get(identity) ?? {
      file: assertion.file,
      test: assertion.name,
      samples_ms: [],
    };
    entry.samples_ms.push(assertion.duration_ms);
    assertionsByIdentity.set(identity, entry);
  }
}

const slowest = [...assertionsByIdentity.values()]
  .map((entry) => ({
    ...entry,
    samples_ms: entry.samples_ms.map(round),
    median_ms: round(median(entry.samples_ms)),
  }))
  .sort((a, b) => b.median_ms - a.median_ms)
  .slice(0, 10);

function hook(name) {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(root, name))).toString("utf8");
  const wrapper = JSON.parse(text.trim().split("\n").at(-1));
  const lefthook = Number(/done in ([0-9.]+) seconds/.exec(text)?.[1]) * 1000;
  const policies = [...text.matchAll(/✔️ ([^\n]+?) \(([0-9.]+) seconds\)/g)].map((match) => ({
    name: match[1],
    duration_ms: Number(match[2]) * 1000,
  }));
  return {
    wall_ms: wrapper.wall_ms,
    lefthook_ms: lefthook,
    exit_status: wrapper.exit_status,
    policies,
  };
}

const route = zlib
  .gunzipSync(fs.readFileSync(path.join(root, "precommit-cli-route.log.gz")))
  .toString("utf8")
  .trim()
  .split("\n");

console.log(
  JSON.stringify(
    {
      source_samples: sources,
      source_medians: {
        cumulative_assertion_ms: round(
          median(sources.map((sample) => sample.cumulative_assertion_ms)),
        ),
        json_elapsed_ms: round(median(sources.map((sample) => sample.json_elapsed_ms))),
        files: median(sources.map((sample) => sample.files)),
        tests: median(sources.map((sample) => sample.tests)),
      },
      slowest_tests_by_median: slowest,
      pre_commit: {
        representative_cli: { ...hook("precommit-cli.log.gz"), route },
        representative_documentation: hook("precommit-documentation.log.gz"),
      },
    },
    null,
    2,
  ),
);
