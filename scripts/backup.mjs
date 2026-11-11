import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const target = process.argv[2];
if (!target || fs.existsSync(target))
  throw new Error("Specify a new backup path");
process.umask(0o077);
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(process.env.DATA_DIR, "olm.sqlite"), {
  readOnly: true,
});
try {
  await backup(db, target);
  fs.chmodSync(target, 0o600);
  console.log("Database backup complete");
} finally {
  db.close();
}
