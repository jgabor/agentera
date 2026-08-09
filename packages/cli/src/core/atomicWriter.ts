import fs from "node:fs";

export interface AtomicWriteOptions {
  preserveTargetMode?: boolean;
}

export function writeFileAtomic(
  target: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf8",
  options: AtomicWriteOptions = {},
): void {
  const targetMode = options.preserveTargetMode ? fs.statSync(target).mode & 0o777 : undefined;
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
    if (Buffer.isBuffer(data)) fs.writeFileSync(tmp, data);
    else fs.writeFileSync(tmp, data, encoding);
    if (targetMode !== undefined) fs.chmodSync(tmp, targetMode);
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
