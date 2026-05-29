import fs from "node:fs";

import { parse as parseTomlString } from "smol-toml";

/** Parse TOML text into a plain object. Mirrors Python tomllib.loads. */
export function parseToml(text: string): Record<string, unknown> {
  return parseTomlString(text) as Record<string, unknown>;
}

/** Read and parse a TOML file. Mirrors Python tomllib.load. */
export function loadTomlFile(path: string): Record<string, unknown> {
  return parseToml(fs.readFileSync(path, "utf8"));
}
