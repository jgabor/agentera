import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Fixed-size streaming match, independent for each output stream. Strip ANSI
// control sequences without retaining their payload or whole output lines.
export function cacheLookupScanner() {
  const needle = "Cache lookup failed";
  let matched = 0;
  let escape = "text";
  let failed = false;
  return {
    write(chunk) {
      for (const byte of chunk) {
        if (escape === "esc") {
          escape = byte === 91 ? "csi" : byte === 93 ? "osc" : "text";
          continue;
        }
        if (escape === "csi") {
          if (byte >= 64 && byte <= 126) escape = "text";
          continue;
        }
        if (escape === "osc" || escape === "osc-esc") {
          if (byte === 7 || (escape === "osc-esc" && byte === 92)) escape = "text";
          else escape = byte === 27 ? "osc-esc" : "osc";
          continue;
        }
        if (byte === 27) {
          escape = "esc";
          continue;
        }
        matched = byte === needle.charCodeAt(matched) ? matched + 1 : byte === 67 ? 1 : 0;
        if (matched === needle.length) {
          failed = true;
          matched = 0;
        }
      }
    },
    get failed() {
      return failed;
    },
  };
}

// Invoke this process OUTSIDE the native cached task. No retry, cache deletion,
// environment/argv logging, or interpretation of arbitrary workflow failures.
export function guardNativeCache(command, args) {
  const stdout = cacheLookupScanner();
  const stderr = cacheLookupScanner();
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], detached: grouped });
  let cancelled;
  let spawnFailed = false;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        cancelled ??= signal;
        if (!child.pid) return;
        try {
          if (grouped) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.stdout.on("data", (chunk) => stdout.write(chunk));
  child.stderr.on("data", (chunk) => stderr.write(chunk));
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.on("error", () => {
    spawnFailed = true;
    // Do not print command arguments or inherited environment.
    process.stderr.write("Native cache guard could not start the child.\n");
  });
  child.on("close", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    const termination = cancelled ?? signal;
    if (termination) {
      process.stdout.write("", () => process.stderr.write("", () => process.kill(process.pid, termination)));
      return;
    }
    if (stdout.failed || stderr.failed) {
      process.stderr.write("Native cache guard rejected a known cache lookup diagnostic. Use the documented fresh entry; this is a workaround, not an upstream repair.\n");
    }
    process.exitCode = spawnFailed || (code === 0 && (stdout.failed || stderr.failed)) ? 1 : (code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("Usage: node guard-native-cache.mjs COMMAND [ARG...]\n");
    process.exitCode = 1;
  } else guardNativeCache(command, args);
}
