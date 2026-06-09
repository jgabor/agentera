import os from "node:os";

import { formatResolvedAppHome } from "../../state/installRoot.js";
import { expanduser } from "../../core/paths.js";

export interface AppHomeArgs {
  installRoot: string | null;
  home: string | null;
  format: "text" | "json";
}

type Io = { out?: (t: string) => void };

export function cmdAppHome(args: AppHomeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const output = formatResolvedAppHome(args.installRoot, {
    env: process.env,
    home: args.home ? expanduser(args.home) : os.homedir(),
    format: args.format,
  });
  out(output + "\n");
  return 0;
}
