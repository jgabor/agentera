import fs from "node:fs";
import { TextDecoder } from "node:util";

import type { Io } from "./types.js";

const MAX_SELECTED_TERM_UTF8_BYTES = 65_536;

export class SelectedTermInputError extends Error {}

export function loadSelectedTermInput(source: string, stdin: Io["stdin"]): string {
  let bytes: Buffer;
  try {
    bytes = source === "-" ? Buffer.from(stdin ? stdin() : fs.readFileSync(0)) : fs.readFileSync(source);
  } catch {
    throw new SelectedTermInputError();
  }
  if (bytes.length === 0 || bytes.length > MAX_SELECTED_TERM_UTF8_BYTES) throw new SelectedTermInputError();
  try {
    const term = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (term.trim().length === 0) throw new SelectedTermInputError();
    return term;
  } catch {
    throw new SelectedTermInputError();
  }
}
