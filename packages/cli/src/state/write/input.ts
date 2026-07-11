import fs from "node:fs";

import { loadYamlMapping } from "../../core/yaml.js";

export function loadStructuredInput(
  source: string,
  readStdin: () => string,
): Record<string, unknown> {
  let text: string;
  if (source === "-") text = readStdin();
  else {
    try {
      text = fs.readFileSync(source, "utf8");
    } catch {
      throw new Error(`input file '${source}' is not readable`);
    }
  }
  try {
    return loadYamlMapping(text);
  } catch (error) {
    throw new Error(`input is not valid YAML or JSON: ${(error as Error).message}`);
  }
}
