import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { openDatabase } from "../src/database.js";
import { hashPassword, loadMasterKey, token } from "../src/crypto.js";

const clientsCount = Number(process.env.LOAD_CLIENTS || 20);
const rounds = Number(process.env.LOAD_ROUNDS || 100);
const dataDir = await mkdtemp(join(tmpdir(), "canvas-load-"));
const origin = "http://localhost:3000", password = token();
await loadMasterKey(join(dataDir, "master.key"));
const db = await openDatabase(join(dataDir, "canvas.sqlite"));
const hash = await hashPassword(password);
const users = Array.from({ length: clientsCount }, (_, i) => ({ id: randomUUID(), username: `load-user-${i}` }));
await db.transaction(users.map((user, i) => ({ sql: "INSERT INTO users(id,username,password_hash,admin,created_at) VALUES(?,?,?,?,?)", params: [user.id, user.username, hash, i === 0 ? 1 : 0, Date.now()] })));
await db.close();
const child = fork(new URL("../src/index.js", import.meta.url), [], {
  env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0", APP_ORIGIN: origin,
    DATA_DIR: dataDir, FILES_DIR: join(dataDir, "files"), MASTER_KEY_FILE: join(dataDir, "master.key"),
    BACKUP_DIR: "", STORAGE_SENTINEL: "", STATIC_DIR: "" },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
child.stderr.on("data", () => {});
const sockets = [];
try {
  const ready = await Promise.race([once(child, "message").then(([value]) => value), once(child, "exit").then(([code]) => { throw new Error(`Server exited during startup: ${code}`); })]);
  const base = `http://127.0.0.1:${ready.port}`;
  const sessions = [];
  const http = async (method, path, body, index = 0) => {
    const auth = sessions[index];
    const response = await fetch(base + path, { method, headers: { origin, "Content-Type": "application/json", "X-Canvas-Protocol": "2",
      "X-Forwarded-For": `198.51.100.${index + 1}`, ...(auth ? { cookie: auth.cookie, "X-CSRF-Token": auth.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(value)}`);
    return { value, response };
  };
  for (let i = 0; i < users.length; i++) {
    const result = await http("POST", "/api/auth/login", { username: users[i].username, password }, i);
    sessions.push({ ...result.value, cookie: result.response.headers.get("set-cookie").split(";")[0] });
  }
  const { value: room } = await http("POST", "/api/rooms", { title: "Isolated 20-user load test" });
  const { value: share } = await http("POST", `/api/rooms/${room.id}/shares`, { role: "editor" });
  for (let i = 1; i < users.length; i++) await http("POST", "/api/shares/join", { token: share.token }, i);
  const privateCanary = `private-canary-${randomUUID()}`;
  let leaked = false;
  const states = [];
  await Promise.all(sessions.map((session, i) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/api/rooms/${room.id}/events?v=2`, { origin, headers: { cookie: session.cookie } });
    sockets.push(ws);
    const state = { revision: 0, nodes: new Map(), cursors: [], gaps: 0 }; states[i] = state;
    ws.on("error", reject);
    ws.on("message", (buffer) => {
      const text = buffer.toString(); if (text.includes(privateCanary)) leaked = true;
      const event = JSON.parse(text);
      if (event.type === "snapshot-node") state.nodes.set(event.node.id, event.node);
      if (event.type === "snapshot-end") { state.revision = event.revision; resolve(); }
      if (event.type === "cursors") state.cursors = event.cursors;
      if (event.type === "changes") {
        if (event.revision !== state.revision + 1) state.gaps++;
        for (const change of event.changes) { if (change.type === "delete") state.nodes.delete(change.id); else if (change.type === "upsert") state.nodes.set(change.node.id, change.node); }
        state.revision = event.revision;
      }
    });
  })));
  const privateId = randomUUID();
  await http("POST", `/api/rooms/${room.id}/operations`, { operationId: randomUUID(), operations: [{ type: "create", node: {
    id: privateId, kind: "private", position: { x: 0, y: 0 }, width: 300, height: 200,
    privateData: { title: privateCanary, note: privateCanary, request: { url: "https://api.example.com", method: "POST", apiKey: privateCanary, header: "Authorization", body: privateCanary } },
  } }] });
  const nodes = users.map((_, i) => ({ id: randomUUID(), kind: "text", position: { x: i * 320, y: 250 }, width: 300, height: 200, title: `User ${i}`, content: "", fileId: null }));
  for (let i = 0; i < nodes.length; i++) await http("POST", `/api/rooms/${room.id}/operations`, { operationId: randomUUID(), operations: [{ type: "create", node: nodes[i] }] }, i);
  const latencies = [];
  const { value: before } = await http("GET", "/api/admin/status");
  let peakRss = before.memory.rss;
  const start = performance.now();
  for (let round = 0; round < rounds; round++) {
    sockets.forEach((socket, i) => socket.send(JSON.stringify({ type: "cursor", position: { x: i * 320 + round, y: 250 + round } })));
    await Promise.all(nodes.map(async (node, i) => {
      const started = performance.now();
      await http("POST", `/api/rooms/${room.id}/operations`, { operationId: randomUUID(), operations: [{ type: "update", id: node.id, version: round + 1, fields: { position: { x: i * 320 + round, y: 250 + round }, content: `User ${i}: round ${round}` } }] }, i);
      latencies.push(performance.now() - started);
    }));
    if ((round + 1) % 25 === 0) {
      const { value: stats } = await http("GET", "/api/admin/status");
      peakRss = Math.max(peakRss, stats.memory.rss);
      console.log(JSON.stringify({ progress: `${round + 1}/${rounds}`, connectedUsers: states.length, serverRssMiB: +(peakRss / 1048576).toFixed(1) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const elapsed = performance.now() - start;
  const expectedRevision = 1 + clientsCount + clientsCount * rounds;
  const deadline = Date.now() + 120000;
  while (states.some((state) => state.revision !== expectedRevision || state.cursors.length !== clientsCount || state.cursors.some((cursor) => cursor.position.y !== 250 + rounds - 1)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(leaked, false);
  for (const state of states) {
    assert.equal(state.revision, expectedRevision);
    assert.equal(state.gaps, 0);
    assert.equal(state.nodes.get(privateId).title, "隐私节点");
    assert.equal(state.cursors.length, clientsCount);
    for (let i = 0; i < users.length; i++) assert.deepEqual(state.cursors.find((cursor) => cursor.userId === users[i].id), { userId: users[i].id, username: users[i].username, position: { x: i * 320 + rounds - 1, y: 250 + rounds - 1 } });
    for (let i = 0; i < nodes.length; i++) assert.equal(state.nodes.get(nodes[i].id).content, `User ${i}: round ${rounds - 1}`);
  }
  const { value: after } = await http("GET", "/api/admin/status");
  peakRss = Math.max(peakRss, after.memory.rss);
  latencies.sort((a, b) => a - b);
  const percentile = (p) => +latencies[Math.floor((latencies.length - 1) * p)].toFixed(2);
  console.log(JSON.stringify({ result: "PASS", clients: clientsCount, writes: latencies.length, elapsedSeconds: +(elapsed / 1000).toFixed(2),
    acknowledgementMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: +latencies.at(-1).toFixed(2) },
    serverPeakRssMiB: +(peakRss / 1048576).toFixed(1), eventLoopDelayMs: after.eventLoopDelayMs, convergence: "all clients identical", namedCursors: clientsCount, privatePayloadLeaked: leaked }, null, 2));
} finally {
  for (const socket of sockets) socket.terminate();
  child.kill("SIGTERM");
  await once(child, "exit");
}
