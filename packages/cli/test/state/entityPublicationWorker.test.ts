import fs from "node:fs";

import { it } from "vitest";

import { publishEntity } from "../../src/state/entityStorage.js";

const root = process.env.AGENTERA_ENTITY_TEST_ROOT;
const artifact = process.env.AGENTERA_ENTITY_TEST_ARTIFACT;
const boundary = process.env.AGENTERA_ENTITY_TEST_BOUNDARY;
const resultPath = process.env.AGENTERA_ENTITY_TEST_RESULT;
const startAt = Number(process.env.AGENTERA_ENTITY_TEST_START);

const worker = root && artifact && boundary && resultPath && Number.isFinite(startAt) ? it : it.skip;

worker("publishes one entity from an isolated process", () => {
  const delay = startAt - Date.now();
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  try {
    const result = publishEntity({
      projectRoot: root!,
      artifact: artifact!,
      boundary: boundary!,
      id: "zzzzzzzzzz",
      record: { writer: artifact! },
    });
    fs.writeFileSync(resultPath!, JSON.stringify({ published: !result.replay }));
  } catch (error) {
    fs.writeFileSync(resultPath!, JSON.stringify({ published: false, error: (error as Error).message }));
  }
});
