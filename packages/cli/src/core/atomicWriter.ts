import fs from "node:fs";

export function writeFileAtomic(
  target: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf8",
): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (Buffer.isBuffer(data)) fs.writeFileSync(tmp, data);
    else fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The stage may not exist or may already have been published.
    }
    throw err;
  }
}
