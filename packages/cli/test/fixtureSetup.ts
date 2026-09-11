import "./gitSetup.ts";
import path from "node:path";

// Native root discovery must preserve the package-cwd contract of source tests.
process.chdir(path.resolve(import.meta.dirname, ".."));
