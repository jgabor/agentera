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
  const resolvedHome = args.home ? expanduser(args.home) : os.homedir();
  let env: Record<string, string | undefined> = process.env;
  if (args.home) {
    env = { ...process.env, HOME: resolvedHome };
    delete env.XDG_DATA_HOME;
    delete env.APPDATA;
    delete env.AGENTERA_HOME;
    delete env.AGENTERA_DEFAULT_INSTALL_ROOT;
  }
  const output = formatResolvedAppHome(args.installRoot, {
    env,
    home: resolvedHome,
    format: args.format,
  });
  out(output + "\n");
  return 0;
}
