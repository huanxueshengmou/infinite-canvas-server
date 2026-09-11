import { join } from "node:path";
import { getConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { loadMasterKey } from "../src/crypto.js";
import { backupDatabase, restoreBackup } from "../src/storage.js";

process.umask(0o077);
const config = getConfig();
const key = await loadMasterKey(config.MASTER_KEY_FILE, false);
if (process.argv[2] === "restore") {
  if (!process.argv[3] || !process.argv[4]) throw new Error("Usage: npm run backup -- restore <archive> <new-database-path>");
  await restoreBackup(process.argv[3], process.argv[4], key);
  console.log("Restored to a new file; validate SQLite integrity before switching databases.");
} else {
  if (!config.BACKUP_DIR) throw new Error("BACKUP_DIR is required");
  const db = await openDatabase(join(config.DATA_DIR, "canvas.sqlite"));
  try { console.log(JSON.stringify(await backupDatabase(db, key, config))); }
  finally { await db.close(); }
}
