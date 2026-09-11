import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getConfig } from "../src/config.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const credentials = JSON.parse(input);
input = "";
const config = getConfig();
const base = `http://127.0.0.1:${config.PORT}`;
let session;
async function api(method, path, body) {
  const headers = { origin: config.APP_ORIGIN };
  if (session) { headers.cookie = session.cookie; headers["X-CSRF-Token"] = session.csrf; }
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, 200, `Verification failed: ${method} ${path}, status ${response.status}`);
  return { data, response };
}
try {
  const login = await api("POST", "/api/auth/login", credentials);
  session = { ...login.data, cookie: login.response.headers.get("set-cookie").split(";")[0] };
  const { data: existingRooms } = await api("GET", "/api/rooms");
  const room = existingRooms.find((room) => room.title === "欢迎使用多人协作画布") || (await api("POST", "/api/rooms", { title: "欢迎使用多人协作画布" })).data;
  const node = { id: randomUUID(), kind: "text", position: { x: 80, y: 80 }, width: 390, height: 270,
    title: "从这里开始", content: "点击底部添加协作文本、共享文件或隐私节点。\n\n右上角可以创建只读或可编辑的分享链接。每位成员使用独立账户；隐私节点的 API 配置与结果只对创建者可见。\n\nAPI 域名请先到「服务管理」加入允许列表。", fileId: null };
  const { data: snapshot } = await api("GET", `/api/rooms/${room.id}`);
  if (!snapshot.nodes.some((item) => item.title === node.title)) await api("POST", `/api/rooms/${room.id}/operations`, { operationId: randomUUID(), operations: [{ type: "create", node }] });
  const marker = `storage-probe-${randomUUID()}`;
  const form = new FormData(); form.append("file", new Blob([marker], { type: "text/plain" }), "storage-check.txt");
  const { data: file } = await api("POST", `/api/rooms/${room.id}/files`, form);
  const downloaded = await fetch(`${base}/api/rooms/${room.id}/files/${file.id}`, { headers: { cookie: session.cookie } });
  assert.equal(await downloaded.text(), marker);
  const { data: backup } = await api("POST", "/api/admin/backup");
  assert.ok(backup.backup?.sha256);
  const { data: status } = await api("GET", "/api/admin/status");
  assert.equal(status.backupError, null);
  console.log(JSON.stringify({ result: "PASS", roomId: room.id, cloudFileBytes: file.size, backupFile: backup.backup.file, backupBytes: backup.backup.bytes }));
} finally { if (session) await api("POST", "/api/auth/logout"); }
