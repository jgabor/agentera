import YAML from "yaml";

export function declaresAgenteraSkill(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return false;

  const metadataLines = lines.slice(1, closing);
  try {
    const document = YAML.parseDocument(metadataLines.join("\n"));
    if (document.errors.length > 0) return false;
    const metadata = document.toJS();
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  } catch {
    return false;
  }

  const names = metadataLines.filter((line) => /^name\s*:/.test(line));
  return names.length === 1 && names[0] === "name: agentera";
}
