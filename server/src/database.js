import { Worker } from "node:worker_threads";
import { mkdir, statfs } from "node:fs/promises";
import { dirname } from "node:path";

export async function openDatabase(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // SQLite WAL requires reliable local shared-memory and locking semantics.
  const filesystem = await statfs(dirname(path));
  if (process.platform === "linux" && [0x65735546, 0x6969, 0xff534d42].includes(filesystem.type)) throw new Error("SQLite DATA_DIR must use a local filesystem, not FUSE/NFS/SMB");
  const worker = new Worker(new URL("./database-worker.js", import.meta.url), { workerData: { path } });
  const pending = new Map();
  let sequence = 0;
  let failure;
  const ready = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.ready) return resolve();
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else request.resolve(message.result);
    });
    const fail = (error) => {
      failure = error;
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(new Error(`Database worker exited: ${code}`)); });
  });
  await ready;
  const call = (method, payload) => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, payload });
    });
  };
  return {
    get: (sql, params = []) => call("query", { sql, params, mode: "get" }),
    all: (sql, params = []) => call("query", { sql, params, mode: "all" }),
    run: (sql, params = []) => call("query", { sql, params }),
    transaction: (steps) => call("transaction", steps),
    backup: (path) => call("backup", { path }),
    close: () => call("close", {}),
    get pending() { return pending.size; },
  };
}
