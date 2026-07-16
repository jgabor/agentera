import fs from "node:fs";

const project = process.env.AGENTERA_LIVE_PREPARATION_ROOT;
const readyPath = process.env.AGENTERA_LIVE_PREPARATION_READY;
const removePath = process.env.AGENTERA_LIVE_PREPARATION_REMOVE;
if (!project || !readyPath || !removePath) {
  throw new Error("live preparation worker requires a project and synchronization paths");
}

const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const directory = `${project}/.agentera/.writer.${process.pid}.${token}.tmp`;
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(`${directory}/owner.json`, `${JSON.stringify({
  pid: process.pid,
  token,
  created_at: new Date().toISOString(),
})}\n`);
fs.writeFileSync(readyPath, "ready\n");

while (!fs.existsSync(removePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
fs.rmSync(directory, { recursive: true });
