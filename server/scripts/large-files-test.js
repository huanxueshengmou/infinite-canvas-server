import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, unlink, rmdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { pipeline } from "node:stream/promises";

const bytes = Number(process.env.FILE_TEST_BYTES || 524288000);
assert.ok(Number.isSafeInteger(bytes) && bytes > 0);
const localRoot = await realpath(tmpdir()), dataDir = await mkdtemp(join(localRoot, "canvas-large-"));
const storageRoot = process.env.FILE_TEST_STORAGE_ROOT ? await realpath(process.env.FILE_TEST_STORAGE_ROOT) : dataDir;
const filesDir = await mkdtemp(join(storageRoot, "canvas-large-files-"));
const origin = "http://localhost:3000";
const child = fork(new URL("../src/index.js", import.meta.url), [], {
  env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", APP_ORIGIN: origin,
    DATA_DIR: dataDir, FILES_DIR: filesDir, MASTER_KEY_FILE: join(dataDir, "master.key"), MAX_FILE_BYTES: String(bytes),
    BACKUP_DIR: "", STORAGE_SENTINEL: process.env.FILE_TEST_STORAGE_SENTINEL || "", STATIC_DIR: "" },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
child.stderr.on("data", (data) => process.stderr.write(data));
let timer, monitorBusy = false, monitorError, auth, peakRss = 0, clientPeakRss = 0;
const healthMs = [];
try {
  const ready = await Promise.race([once(child, "message").then(([value]) => value), once(child, "exit").then(([code]) => { throw new Error(`Server startup failed: ${code}`); })]);
  const base = `http://127.0.0.1:${ready.port}`;
  const api = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { origin, "Content-Type": "application/json", ...(auth ? { cookie: auth.cookie, "X-CSRF-Token": auth.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return { value: await response.json(), response };
  };
  const registered = await api("POST", "/api/auth/register", { username: "isolated-large-file-test", password: "isolated-large-file-test-password" });
  auth = { ...registered.value, cookie: registered.response.headers.get("set-cookie").split(";")[0] };
  // The isolated database belongs only to this test; production accounts are never touched.
  const { openDatabase } = await import("../src/database.js");
  const testDb = await openDatabase(join(dataDir, "canvas.sqlite"));
  await testDb.run("UPDATE users SET admin=1 WHERE id=?", [auth.user.id]);
  await testDb.close();
  const { value: room } = await api("POST", "/api/rooms", { title: "Isolated large file acceptance" });
  const monitor = async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const start = performance.now(); await api("GET", "/health"); healthMs.push(performance.now() - start);
      const { value: status } = await api("GET", "/api/admin/status"); peakRss = Math.max(peakRss, status.memory.rss);
      clientPeakRss = Math.max(clientPeakRss, process.memoryUsage().rss);
    } catch (error) { monitorError = error; }
    finally { monitorBusy = false; }
  };
  await monitor(); timer = setInterval(() => void monitor(), 1000);
  const chunk = Buffer.alloc(65536, 0x5a), expected = createHash("sha256");
  for (let offset = 0; offset < bytes; offset += chunk.length) expected.update(chunk.subarray(0, Math.min(chunk.length, bytes - offset)));
  const expectedHash = expected.digest("hex");
  const upload = async (size) => {
    const boundary = "canvas-large-file-boundary", prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from((async function* () {
      yield prefix;
      for (let offset = 0; offset < size; offset += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - offset));
      yield suffix;
    })(), { objectMode: false });
    const start = performance.now();
    let sending;
    const response = await new Promise((resolveResponse, reject) => {
      const req = httpRequest(`${base}/api/rooms/${room.id}/files`, { method: "POST", headers: { origin, cookie: auth.cookie, "X-CSRF-Token": auth.csrf, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(prefix.length + size + suffix.length) } }, async (res) => {
        try { const chunks = []; for await (const data of res) chunks.push(data); resolveResponse({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
      req.on("error", reject);
      // Respect the socket's byte-stream backpressure even when the FUSE destination is slow.
      sending = pipeline(body, req).catch((error) => error);
    });
    const sendError = await sending;
    if (sendError && response.status < 400) throw sendError;
    console.log(JSON.stringify({ stage: "upload", fileBytes: size, status: response.status, seconds: +((performance.now() - start) / 1000).toFixed(2) }));
    return response;
  };
  const excess = await upload(bytes + 1); assert.equal(excess.status, 413, JSON.stringify(excess.value));
  assert.deepEqual(await readdir(filesDir), []);
  const uploaded = await Promise.all([upload(bytes), upload(bytes)]);
  for (const file of uploaded) { assert.equal(file.status, 200, JSON.stringify(file.value)); assert.equal(file.value.size, bytes); }
  const downloads = await Promise.all(uploaded.map(async ({ value: file }) => {
    const start = performance.now(), hash = createHash("sha256");
    const response = await fetch(`${base}/api/rooms/${room.id}/files/${file.id}`, { headers: { cookie: auth.cookie } });
    const firstByteMs = performance.now() - start;
    assert.equal(response.status, 200); assert.equal(Number(response.headers.get("content-length")), bytes);
    let size = 0;
    for await (const data of response.body) { size += data.length; hash.update(data); }
    assert.equal(size, bytes); assert.equal(hash.digest("hex"), expectedHash);
    const result = { firstByteMs: +firstByteMs.toFixed(2), seconds: +((performance.now() - start) / 1000).toFixed(2) };
    console.log(JSON.stringify({ stage: "download", fileBytes: size, ...result }));
    return result;
  }));
  // HTTP EOF can reach the client before the server's awaited cleanup finishes.
  // Wait for both IO slots to be released, then assert that every snapshot is gone.
  const { value: meta } = await api("GET", "/api/meta");
  const cleanupDeadline = Date.now() + meta.apiTimeoutMs;
  let active;
  do {
    active = (await api("GET", "/api/admin/status")).value.ioActive;
    if (active) await new Promise((resolve) => setTimeout(resolve, meta.syncBatchMs));
  } while (active && Date.now() < cleanupDeadline);
  assert.equal(active, 0);
  await monitor(); if (monitorError) throw monitorError;
  assert.equal((await readdir(dataDir)).filter((name) => name.startsWith("download-")).length, 0);
  healthMs.sort((a, b) => a - b);
  console.log(JSON.stringify({ result: "PASS", fileMiB: bytes / 1048576, concurrentUploads: 2, concurrentDownloads: 2, excessByteRejected: true, sha256Verified: true,
    serverPeakRssMiB: +(peakRss / 1048576).toFixed(1), clientPeakRssMiB: +(clientPeakRss / 1048576).toFixed(1), healthP95Ms: +healthMs[Math.floor((healthMs.length - 1) * 0.95)].toFixed(2), downloads, storage: process.env.FILE_TEST_STORAGE_ROOT ? "configured mount" : "local temporary directory" }, null, 2));
} finally {
  if (timer) clearInterval(timer);
  if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  // Both paths were created exclusively above; verify their parents before deleting test data.
  assert.equal(dirname(await realpath(filesDir)), await realpath(storageRoot));
  assert.ok(basename(filesDir).startsWith("canvas-large-files-"));
  for (const name of await readdir(filesDir)) {
    assert.match(name, /^[a-f0-9-]{36}\.enc$/);
    await unlink(join(filesDir, name));
  }
  await rmdir(filesDir);
  assert.equal(dirname(await realpath(dataDir)), localRoot);
  assert.ok(basename(dataDir).startsWith("canvas-large-"));
  await rm(resolve(dataDir), { recursive: true });
}
