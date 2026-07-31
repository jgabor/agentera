import fs from "node:fs";

import { loadYamlMapping } from "../../core/yaml.js";

export function loadStructuredInput(
  source: string,
  readStdin: () => string,
  maxBytes?: number,
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
  if (maxBytes !== undefined && maxBytes > 0 && Buffer.byteLength(text, "utf8") > maxBytes)
    throw new Error(`input exceeds the ${maxBytes}-byte UTF-8 limit`);
  try {
    return loadYamlMapping(text);
  } catch (error) {
    throw new Error(`input is not valid YAML or JSON: ${(error as Error).message}`);
  }
}
