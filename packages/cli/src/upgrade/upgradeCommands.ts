import type { ResolvedUpdateChannel } from "./channels.js";

export type UpgradeOnlyPhase = "artifacts" | "runtime" | "cleanup";

export interface BuildUpgradeCommandsArgs {
  project: string;
  /** When omitted, upgrade commands target --project only (v1 migration hints). */
  installRoot?: string | null;
  channel: ResolvedUpdateChannel;
  only?: readonly UpgradeOnlyPhase[] | null;
  /** When true, omit --project from user-facing command strings (defaults to cwd). */
  cwdDefault?: boolean;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function commandText(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

/** Channel-aware upgrade preview/apply commands (doctor, prime, orchestrator). */
export function buildUpgradeCommands(args: BuildUpgradeCommandsArgs): {
  dryRunCommand: string;
  applyCommand: string;
} {
  const base = args.channel.updateCommand.split(/\s+/).slice(0, 3);
  const previewParts = [...base, "upgrade"];
  const applyParts = [...base, "upgrade"];
  if (!args.cwdDefault) {
    previewParts.push("--project", args.project);
    applyParts.push("--project", args.project);
  }
  if (args.installRoot) {
    previewParts.push("--install-root", args.installRoot);
    applyParts.push("--install-root", args.installRoot);
  }
  previewParts.push("--dry-run");
  applyParts.push("--yes");
  if (args.channel.channel !== "stable") {
    previewParts.push("--channel", args.channel.channel);
    applyParts.push("--channel", args.channel.channel);
  }
  if (args.only && args.only.length > 0) {
    for (const phase of args.only) {
      previewParts.push("--only", phase);
      applyParts.push("--only", phase);
    }
  }
  return {
    dryRunCommand: commandText(previewParts),
    applyCommand: commandText(applyParts),
  };
}
