import { stdin } from "node:process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { loadMasterKey, hashPassword } from "../src/crypto.js";
import { credentialsSchema } from "../src/schemas.js";

process.umask(0o077);
// Supply JSON on stdin from a password manager or protected file; never use CLI password arguments.
let input = "";
for await (const chunk of stdin) input += chunk;
const credentials = credentialsSchema.parse(JSON.parse(input));
input = "";
const config = getConfig();
const path = join(config.DATA_DIR, "canvas.sqlite");
await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
const existing = await stat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
await loadMasterKey(config.MASTER_KEY_FILE, !existing);
const db = await openDatabase(path);
try {
  const username = credentials.username.toLowerCase();
  const existingUser = await db.get("SELECT id FROM users WHERE username=?", [username]);
  const passwordHash = await hashPassword(credentials.password);
  if (process.argv.includes("--reset")) {
    if (!existingUser) throw new Error("Account does not exist");
    await db.transaction([
      { sql: "UPDATE users SET password_hash=? WHERE id=?", params: [passwordHash, existingUser.id] },
      { sql: "DELETE FROM sessions WHERE user_id=?", params: [existingUser.id] },
    ]);
    console.log("Password reset. Restart the application before reopening access; old sessions are invalid.");
  } else {
    if (existingUser) throw new Error("Account already exists; refusing to overwrite it");
    await db.run("INSERT INTO users(id,username,password_hash,admin,created_at) VALUES(?,?,?,?,?)", [randomUUID(), username, passwordHash, 1, Date.now()]);
    console.log("Administrator created. No password was logged.");
  }
} finally { await db.close(); }
