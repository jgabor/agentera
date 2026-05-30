import type { ResolvedUpdateChannel } from "./channels.js";

export type UpgradeOnlyPhase = "artifacts" | "runtime" | "cleanup";

export interface BuildUpgradeCommandsArgs {
  project: string;
  /** When omitted, upgrade commands target --project only (v1 migration hints). */
  installRoot?: string | null;
  channel: ResolvedUpdateChannel;
  targetMajor?: number | null;
  only?: readonly UpgradeOnlyPhase[] | null;
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
  const previewParts = [...base, "upgrade", "--project", args.project];
  const applyParts = [...base, "upgrade", "--project", args.project];
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
  if (args.targetMajor === 3) {
    previewParts.push("--target-major", "3");
    applyParts.push("--target-major", "3");
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
