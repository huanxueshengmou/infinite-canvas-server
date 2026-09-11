import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, open, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { HttpError } from "./rooms.js";

export async function checkStorage(config) {
  if (config.STORAGE_SENTINEL) {
    try {
      const marker = await readFile(config.STORAGE_SENTINEL, "utf8");
      if (marker.trim() !== "infinite-canvas-storage-v1") throw new Error("Wrong storage marker");
    } catch { throw new HttpError(503, "挂载存储不可用，已暂停写入，请联系管理员"); }
  }
}

export async function saveEncryptedFile(stream, id, key, config) {
  await checkStorage(config);
  await mkdir(config.FILES_DIR, { recursive: true, mode: 0o700 });
  const path = join(config.FILES_DIR, `${id}.enc`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`file:${id}`));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.write(iv);
    await pipeline(stream, cipher, createWriteStream(path, { flags: "r+", start: 12 }));
    if (stream.truncated) throw new HttpError(413, "文件超过大小限制，未保存");
    await handle.write(cipher.getAuthTag(), 0, 16, (await handle.stat()).size);
    await handle.sync();
    return (await handle.stat()).size - 28;
  } catch (error) {
    await handle.close();
    // Only the incomplete, randomly named file created by this request is removed.
    await unlink(path).catch(() => {});
    throw error;
  } finally { await handle.close().catch(() => {}); }
}

export async function readEncryptedFile(id, key, config) {
  await checkStorage(config);
  const data = await readFile(join(config.FILES_DIR, `${id}.enc`));
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(`file:${id}`));
  decipher.setAuthTag(data.subarray(-16));
  // Authenticate before serving any bytes. Concurrency bounds the memory used by this buffer.
  return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
}

export async function backupDatabase(db, key, config) {
  if (!config.BACKUP_DIR) return null;
  await checkStorage(config);
  await mkdir(config.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const temporary = join(config.DATA_DIR, `backup-${id}.sqlite`);
  const destination = join(config.BACKUP_DIR, `${id}.sqlite.gz.enc`);
  try {
    await db.backup(temporary);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("infinite-canvas-backup-v1"));
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.write(iv);
      await pipeline(createReadStream(temporary), createGzip(), cipher, createWriteStream(destination, { flags: "r+", start: 12 }));
      await handle.write(cipher.getAuthTag(), 0, 16, (await handle.stat()).size);
      await handle.sync();
    } finally { await handle.close(); }
    // A manifest marks completion; partial archives are never offered for restore.
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    const manifest = { version: 1, file: `${id}.sqlite.gz.enc`, bytes: (await stat(destination)).size, sha256: hash.digest("hex"), createdAt: new Date().toISOString() };
    await writeFile(`${destination}.json`, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function restoreBackup(archive, destination, key) {
  const manifest = JSON.parse(await readFile(`${archive}.json`, "utf8"));
  const info = await stat(archive);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (manifest.version !== 1 || manifest.bytes !== info.size || manifest.sha256 !== hash.digest("hex")) throw new Error("Backup checksum mismatch");
  const handle = await open(archive, "r");
  const iv = Buffer.alloc(12), tag = Buffer.alloc(16);
  try {
    await handle.read(iv, 0, 12, 0);
    await handle.read(tag, 0, 16, info.size - 16);
  } finally { await handle.close(); }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("infinite-canvas-backup-v1"));
  decipher.setAuthTag(tag);
  // Never overwrite a running database or an existing recovery target.
  await pipeline(createReadStream(archive, { start: 12, end: info.size - 17 }), decipher, createGunzip(), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}
