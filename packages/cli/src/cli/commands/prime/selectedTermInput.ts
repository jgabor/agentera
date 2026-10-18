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
    // Here-strings, echo, and editors end the scalar with one line terminator
    // that is not part of the term; exact matching keeps every other byte.
    const term = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/u, "");
    if (term.trim().length === 0) throw new SelectedTermInputError();
    return term;
  } catch {
    throw new SelectedTermInputError();
  }
}
