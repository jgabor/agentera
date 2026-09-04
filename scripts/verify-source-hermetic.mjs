#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-hermetic-source-"));

try {
  const directory = (name) => {
    const value = path.join(root, name);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "../packages/cli/scripts/verify-lane.mjs"), "source"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: directory("home"),
      XDG_CONFIG_HOME: directory("xdg-config"),
      XDG_DATA_HOME: directory("xdg-data"),
      XDG_CACHE_HOME: directory("xdg-cache"),
      XDG_STATE_HOME: directory("xdg-state"),
      AGENTERA_HOME: directory("app"),
      npm_config_cache: directory("npm-cache"),
      PNPM_HOME: directory("pnpm-home"),
      COREPACK_HOME: directory("corepack"),
      VP_HOME: directory("vite-plus"),
      TMPDIR: directory("tmp"),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
