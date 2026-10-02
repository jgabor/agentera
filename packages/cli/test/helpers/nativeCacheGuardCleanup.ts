import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Test-only observation of the guard's real spawn. Record its detached group
// before returning to the guard, including before the inner program starts.
export function trackGuardChild(root: string, guard: string) {
  const marker = path.join(root, "guard-child-pid.json");
  const preload = path.join(root, "track-guard-child.cjs");
  fs.writeFileSync(
    preload,
    `const cp = require('node:child_process');
if (process.argv[1] === ${JSON.stringify(guard)}) {
  const original = cp.spawn;
  cp.spawn = function (...args) {
    const child = original.apply(this, args);
    if (child.pid) require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(child.pid));
    return child;
  };
  require('node:module').syncBuiltinESMExports();
}
`,
  );
  return {
    marker,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
    },
  };
}

function signal(pid: number | undefined, name: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

// Match coldProcessScheduler's 250ms termination grace. The inner group is not
// the outer test group: SIGKILL of the guard alone cannot forward cancellation.
// Await close (including inherited descendant pipes) before deleting fixtures.
export async function stopGuardChild<T>(child: ChildProcess, closed: Promise<T>, marker: string, outerGroup = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal(child.pid && (outerGroup ? -child.pid : child.pid), "SIGTERM");
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (fs.existsSync(marker)) {
    const pid = JSON.parse(fs.readFileSync(marker, "utf8"));
    signal(-pid, "SIGKILL");
    // Keep the guard alive to reap its child, and drain descendants' pipes.
    await closed;
  }
  signal(child.pid && (outerGroup ? -child.pid : child.pid), "SIGKILL");
  return await closed;
}
