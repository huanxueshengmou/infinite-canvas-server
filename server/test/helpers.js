import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { hashPassword } from "../src/crypto.js";

export async function fixture(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "canvas-test-"));
  const config = getConfig({ NODE_ENV: "test", DATA_DIR: root, APP_ORIGIN: "http://localhost:3000", ...overrides });
  const app = await createApp({ config, ...options });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const port = app.server.address().port;
  const password = "canvas-test-strong-password";
  const passwordHash = await hashPassword(password);
  const user = async (username, admin = false) => {
    const id = randomUUID();
    await app.context.db.run("INSERT INTO users(id,username,password_hash,admin,created_at) VALUES(?,?,?,?,?)", [id, username, passwordHash, admin ? 1 : 0, Date.now()]);
    return { id, username, password };
  };
  const request = async (method, path, body, auth, extraHeaders = {}) => {
    const headers = { origin: config.APP_ORIGIN, "x-canvas-protocol": "2", ...extraHeaders };
    if (auth) { headers.cookie = auth.cookie; headers["x-csrf-token"] = auth.csrf; }
    const response = await app.inject({ method, url: path, payload: body, headers });
    return { response, status: response.statusCode, body: response.headers["content-type"]?.includes("application/json") ? response.json() : response.body };
  };
  const login = async (u) => {
    const result = await request("POST", "/api/auth/login", { username: u.username, password: u.password });
    if (result.status !== 200) throw new Error(`Login failed: ${JSON.stringify(result.body)}`);
    return { ...result.body, cookie: result.response.headers["set-cookie"].split(";")[0] };
  };
  const room = async (auth) => (await request("POST", "/api/rooms", { title: "Test canvas" }, auth)).body;
  const share = async (roomId, auth, role = "editor", extra = {}) => (await request("POST", `/api/rooms/${roomId}/shares`, { role, ...extra }, auth)).body;
  const joinRoom = (invitation, auth) => request("POST", "/api/shares/join", { token: invitation.token }, auth);
  const send = (roomId, auth, operations, operationId = randomUUID()) => request("POST", `/api/rooms/${roomId}/operations`, { operationId, operations }, auth);
  const socket = (roomId, auth, origin = config.APP_ORIGIN) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${roomId}/events?v=2`, { origin, headers: auth ? { cookie: auth.cookie } : {} });
    const events = [];
    ws.on("message", (data) => events.push(JSON.parse(data.toString())));
    const ready = new Promise((resolve, reject) => {
      ws.on("message", (data) => { if (JSON.parse(data.toString()).type === "snapshot-end") resolve(); });
      ws.on("error", reject);
    });
    return { ws, events, ready };
  };
  return { app, root, config, port, user, request, login, room, share, joinRoom, send, socket };
}

export const textNode = (title = "Hello") => ({ id: randomUUID(), kind: "text", title, content: "Shared text", fileId: null, position: { x: 10, y: 20 }, width: 300, height: 200 });
export const privateData = (secret = "test-private-api-key") => ({ title: "Confidential title", note: "Confidential note", request: { url: "https://api.example.com/v1/request", method: "POST", apiKey: secret, header: "Authorization", body: '{"private":"request-body"}' } });
export const privateNode = () => ({ ...textNode(), kind: "private", privateData: privateData() });

export async function storageRoot(root) {
  const mount = join(root, "mount");
  await mkdir(mount);
  const sentinel = join(mount, ".canvas-storage");
  await writeFile(sentinel, "infinite-canvas-storage-v1\n");
  return { mount, sentinel };
}
