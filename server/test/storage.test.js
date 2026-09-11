import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture, textNode, storageRoot } from "./helpers.js";
import { backupDatabase, restoreBackup, saveEncryptedFile, readEncryptedFile } from "../src/storage.js";
import { openDatabase } from "../src/database.js";

test("cloud archives are encrypted, checked and restorable without overwriting files", async (t) => {
  const f = await fixture(t);
  const { mount, sentinel } = await storageRoot(f.root);
  const config = { ...f.config, BACKUP_DIR: join(mount, "backups"), FILES_DIR: join(mount, "files"), STORAGE_SENTINEL: sentinel };
  const user = await f.login(await f.user("backup-owner")), room = await f.room(user);
  const node = textNode("backup-canary-title");
  assert.equal((await f.send(room.id, user, [{ type: "create", node }])).status, 200);
  const backup = await backupDatabase(f.app.context.db, f.app.context.key, config);
  assert.ok(backup.bytes > 0);
  const archive = join(config.BACKUP_DIR, backup.file), restored = join(f.root, "restored.sqlite");
  assert.ok(!(await readFile(archive)).includes(Buffer.from(node.title)));
  await restoreBackup(archive, restored, f.app.context.key);
  const restoredDb = new DatabaseSync(restored, { readOnly: true });
  assert.equal(restoredDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(restoredDb.prepare("SELECT count(*) AS count FROM nodes").get().count, 1);
  restoredDb.close();
  await assert.rejects(restoreBackup(archive, restored, f.app.context.key), /EEXIST/);
  const before = await readFile(restored);
  await assert.rejects(restoreBackup(archive, join(f.root, "wrong-key.sqlite"), randomBytes(32)));
  assert.deepEqual(await readFile(restored), before);
  await writeFile(sentinel, "wrong-mount");
  await assert.rejects(backupDatabase(f.app.context.db, f.app.context.key, config), /挂载/);
});

test("files are streamed encrypted, authenticated before serving, and denied on mount loss", async (t) => {
  const f = await fixture(t);
  const { mount, sentinel } = await storageRoot(f.root);
  const config = { ...f.config, FILES_DIR: join(mount, "files"), STORAGE_SENTINEL: sentinel };
  const content = Buffer.from("sensitive-file-content"), id = randomUUID();
  const size = await saveEncryptedFile(Readable.from(content), id, f.app.context.key, config);
  assert.equal(size, content.length);
  const file = join(config.FILES_DIR, `${id}.enc`);
  const encrypted = await readFile(file);
  assert.ok(!encrypted.includes(content));
  assert.deepEqual(await readEncryptedFile(id, f.app.context.key, config), content);
  encrypted[14] ^= 1;
  await writeFile(file, encrypted);
  await assert.rejects(readEncryptedFile(id, f.app.context.key, config));
  await writeFile(sentinel, "unavailable");
  await assert.rejects(saveEncryptedFile(Readable.from(content), randomUUID(), f.app.context.key, config), /挂载/);
});

test("API concurrency uses backpressure without blocking room mutations or health requests", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const f = await fixture(t, {}, { executeRequest: async () => { started++; await gate; return { status: 200, text: "ok" }; } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const { privateNode } = await import("./helpers.js");
  const node = privateNode();
  await f.send(room.id, owner, [{ type: "create", node }]);
  const fileId = randomUUID();
  await saveEncryptedFile(Readable.from("queued-file"), fileId, f.app.context.key, f.config);
  await f.app.context.db.run("INSERT INTO files(id,room_id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?,?)", [fileId, room.id, owner.user.id, "application/octet-stream", 11, Date.now()]);
  const run = () => f.request("POST", `/api/rooms/${room.id}/private/${node.id}/run`, { version: 1 }, owner);
  const first = run(), second = run();
  while (started < 2) await new Promise((resolve) => setImmediate(resolve));
  let downloaded = false;
  const download = f.request("GET", `/api/rooms/${room.id}/files/${fileId}`, undefined, owner).then((result) => { downloaded = true; return result; });
  try {
    assert.equal((await run()).status, 429);
    assert.equal(downloaded, false);
    assert.equal((await f.request("GET", "/health")).status, 200);
    assert.equal((await f.send(room.id, owner, [{ type: "create", node: textNode() }])).status, 200);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await download).status, 200);
  assert.equal((await download).body, "queued-file");
});

test("unknown database versions fail closed without changing the original version", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-version-test-"));
  const path = join(root, "future.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=99");
  db.close();
  await assert.rejects(openDatabase(path), /Unknown database version/);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 99);
  check.close();
});
