import path from "node:path";
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function isolatedEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    CURSOR_HOME: path.join(root, ".cursor"),
    CURSOR_CONFIG_HOME: path.join(root, ".config", "cursor"),
    COPILOT_HOME: path.join(root, ".copilot"),
    AGENTERA_HOME: root,
  };
}

export function seedOpencodeManySessions(dbp: string, count: number, baseTime = 1_700_000_000): void {
  const db = new DatabaseSync(dbp);
  db.exec("CREATE TABLE session(id TEXT, cwd TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE message(id TEXT, sessionID TEXT, role TEXT, time_created INTEGER, content TEXT, data TEXT)");
  db.exec("CREATE TABLE part(id TEXT, messageID TEXT, type TEXT, text TEXT, data TEXT, time_created INTEGER)");
  const insertSession = db.prepare("INSERT INTO session VALUES (?,?,?)");
  const insertMessage = db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)");
  const insertPart = db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    const sid = `s${i}`;
    const ts = baseTime + i;
    insertSession.run(sid, "/proj", ts);
    insertMessage.run(`m${i}`, sid, "user", ts, null, null);
    insertPart.run(`p${i}`, `m${i}`, "text", "hello", null, ts);
  }
  db.exec("COMMIT");
  db.close();
}
