import YAML from "yaml";

/**
 * Structured output emitter mirroring scripts/agentera's `_emit_structured`:
 *   json -> json.dumps(value, ensure_ascii=False, indent=2)
 *   yaml -> yaml.safe_dump(value, sort_keys=False)
 *
 * Python json.dumps(ensure_ascii=False, indent=2) and JSON.stringify(value, null, 2)
 * produce identical text for the plain object/array/scalar payloads the CLI emits.
 */
export function emitStructured(value: unknown, outputFormat: string, out: (text: string) => void): void {
  if (outputFormat === "json") {
    out(JSON.stringify(value, null, 2) + "\n");
  } else if (outputFormat === "yaml") {
    out(YAML.stringify(value, { sortMapEntries: false }));
  }
}
