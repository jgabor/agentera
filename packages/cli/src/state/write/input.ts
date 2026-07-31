import fs from "node:fs";

import { loadYamlMapping } from "../../core/yaml.js";

export function loadStructuredInput(
  source: string,
  readStdin: () => string | Buffer,
  maxBytes?: number,
): Record<string, unknown> {
  let bytes: Buffer;
  if (source === "-") {
    const input = readStdin();
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  }
  else {
    try {
      bytes = fs.readFileSync(source);
    } catch {
      throw new Error(`input file '${source}' is not readable`);
    }
  }
  if (maxBytes !== undefined && maxBytes > 0 && bytes.byteLength > maxBytes)
    throw new Error(`input exceeds the ${maxBytes}-byte UTF-8 limit`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("input is not valid UTF-8");
  }
  try {
    return loadYamlMapping(text);
  } catch (error) {
    throw new Error(`input is not valid YAML or JSON: ${(error as Error).message}`);
  }
}
