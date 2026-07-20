import fs from "node:fs";
import path from "node:path";

export function waitForVerificationBarrier(env = process.env) {
  const root = env.AGENTERA_VERIFICATION_BARRIER;
  const participant = env.AGENTERA_VERIFICATION_PARTICIPANT;
  if (!root && !participant) return;
  if (!root || !participant || !/^(source|build|package)$/.test(participant)) {
    throw new Error("verification overlap barrier requires a root and source, build, or package participant");
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${participant}.ready`), `${process.pid}\n`, { flag: "wx" });
  const release = path.join(root, "release");
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`verification overlap barrier timed out for ${participant}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
