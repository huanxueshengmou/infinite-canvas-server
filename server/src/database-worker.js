import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";

const db = new DatabaseSync(workerData.path);
const storageVersion = db.prepare("PRAGMA user_version").get().user_version;
if (![0, 1, 2, 3].includes(storageVersion)) throw new Error("Unknown database version; refusing to alter stored data");
if (storageVersion > 0 && storageVersion < 3) {
  const beforeMigration = `${workerData.path}.before-v3-${randomUUID()}.sqlite`;
  await backup(db, beforeMigration);
  await chmod(beforeMigration, 0o600);
}
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  BEGIN IMMEDIATE;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
    revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('viewer','editor')), password_hash TEXT,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK(role IN ('viewer','editor')), share_id TEXT REFERENCES shares(id),
    PRIMARY KEY(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id), owner_id TEXT NOT NULL REFERENCES users(id),
    visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
    version INTEGER NOT NULL, public_json TEXT NOT NULL, private_cipher TEXT,
    private_version INTEGER NOT NULL DEFAULT 1, result_cipher TEXT,
    PRIMARY KEY(room_id, id)
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), owner_id TEXT NOT NULL REFERENCES users(id),
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receipts (
    room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY(room_id, user_id, operation_id)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, user_id TEXT, room_id TEXT, action TEXT NOT NULL,
    target_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id),
    source TEXT NOT NULL, source_port TEXT NOT NULL, target TEXT NOT NULL, target_port TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY(room_id,id),
    UNIQUE(room_id,target,target_port),
    FOREIGN KEY(room_id,source) REFERENCES nodes(room_id,id) ON DELETE CASCADE,
    FOREIGN KEY(room_id,target) REFERENCES nodes(room_id,id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS node_templates (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
    cipher TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operation_history (
    room_id TEXT NOT NULL REFERENCES rooms(id), user_id TEXT NOT NULL REFERENCES users(id),
    id TEXT NOT NULL, cipher TEXT NOT NULL,
    PRIMARY KEY(room_id,user_id,id)
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
  CREATE INDEX IF NOT EXISTS shares_room ON shares(room_id);
  CREATE INDEX IF NOT EXISTS audit_room ON audit(room_id, id);
  CREATE INDEX IF NOT EXISTS edges_source ON edges(room_id,source);
  CREATE INDEX IF NOT EXISTS node_templates_owner ON node_templates(owner_id);
  PRAGMA user_version=3;
  COMMIT;
`);

function execute(step) {
  const statement = db.prepare(step.sql);
  const args = step.params || [];
  const result = step.mode === "all" ? statement.all(...args) : step.mode === "get" ? statement.get(...args) : statement.run(...args);
  if (step.expectChanges !== undefined && result.changes !== step.expectChanges) throw new Error("CONFLICT");
  return result;
}

// All SQLite calls, including FULL fsyncs and backup copies, stay off the HTTP event loop.
parentPort.on("message", async ({ id, method, payload }) => {
  try {
    let result;
    if (method === "query") result = execute(payload);
    else if (method === "transaction") {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = payload.map(execute);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (method === "backup") result = await backup(db, payload.path);
    else if (method === "close") {
      db.close();
      parentPort.postMessage({ id, result: true });
      parentPort.close();
      return;
    } else throw new Error("Unknown database operation");
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
parentPort.postMessage({ ready: true });
