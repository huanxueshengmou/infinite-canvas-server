import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, textNode, privateNode, privateData } from "./helpers.js";
import { saveEncryptedFile } from "../src/storage.js";
import { openDatabase } from "../src/database.js";
import { renderJson, atPath } from "../src/workflow.js";

const custom = (content = "{{input.text}}", outputType = "text") => ({ ...textNode(), kind: "custom", content, outputType });
const edge = (source, target, targetPort = "input") => ({ id: randomUUID(), source: source.id, sourcePort: "output", target: target.id, targetPort });

test("connections synchronize, reject cycles/invalid ports and support atomic versioned reconnects", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), viewer = await f.login(await f.user("viewer"));
  const room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner, "viewer"), viewer);
  const a = textNode(), b = custom(), c = custom(), link = edge(a, b), next = edge(b, c);
  const operations = [a, b, c].map((node) => ({ type: "create", node })).concat([{ type: "connect", edge: link }, { type: "connect", edge: next }]);
  const operationId = randomUUID();
  const first = await f.send(room.id, owner, operations, operationId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual((await f.send(room.id, owner, operations, operationId)).body, first.body);
  const observer = f.socket(room.id, viewer); await observer.ready;
  assert.equal(observer.events.filter((event) => event.type === "snapshot-edge").length, 2);
  assert.equal((await f.send(room.id, viewer, [{ type: "disconnect", id: link.id, version: 1 }])).status, 403);
  const cycle = await f.send(room.id, owner, [{ type: "disconnect", id: link.id, version: 1 }, { type: "connect", edge: edge(c, b) }]);
  assert.equal(cycle.status, 400);
  assert.equal((await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body.edges.length, 2);
  assert.equal((await f.send(room.id, owner, [{ type: "connect", edge: edge(a, c) }])).status, 409);
  assert.equal((await f.send(room.id, owner, [{ type: "connect", edge: edge(a, b, "image") }])).status, 400);
  assert.equal((await f.send(room.id, owner, [{ type: "connect", edge: { ...link, source: randomUUID() }, version: 1 }])).status, 400);
  assert.equal((await f.send(room.id, owner, [{ type: "connect", edge: { ...next, source: a.id }, version: 1 }])).status, 200);
  assert.equal((await f.send(room.id, owner, [{ type: "disconnect", id: next.id, version: 1 }])).status, 409);
  assert.equal((await f.send(room.id, owner, [{ type: "delete", id: a.id, version: 1 }])).status, 200);
  const snapshot = (await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body;
  assert.equal(snapshot.edges.length, 0);
  observer.ws.close();
});

test("public custom outputs flow into private requests with safe JSON escaping and typed fields", async (t) => {
  let sent;
  const f = await fixture(t, {}, { executeRequest: async (request) => { sent = request; return { status: 200, text: '{"choices":[{"message":{"content":"private improved prompt"}}]}' }; } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const a = { ...textNode(), content: 'A "quoted" line\n第二行' }, b = custom('{"prompt":"{{input.text}}"}', "json"), p = privateNode();
  p.privateData.request.body = '{"prompt":"{{input.json.prompt}}","count":"{{params.count}}","optional":"{{image.dataUrl?}}"}';
  p.privateData.fields = [{ name: "count", label: "数量", type: "number", value: 2 }];
  const created = await f.send(room.id, owner, [a, b, p].map((node) => ({ type: "create", node })).concat([{ type: "connect", edge: edge(a, b) }, { type: "connect", edge: edge(b, p) }]));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const output = await f.request("POST", `/api/rooms/${room.id}/nodes/${b.id}/evaluate`, {}, owner);
  assert.deepEqual(output.body.json, { prompt: a.content });
  const run = await f.request("POST", `/api/rooms/${room.id}/private/${p.id}/run`, { version: 1 }, owner);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(JSON.parse(sent.body), { prompt: a.content, count: 2 });
  assert.equal(sent.apiKey, p.privateData.request.apiKey);
  const downstream = privateNode(); downstream.privateData.request.body = '{"prompt":"{{input.text}}"}';
  await f.send(room.id, owner, [{ type: "create", node: downstream }, { type: "connect", edge: edge(p, downstream) }]);
  assert.equal((await f.request("POST", `/api/rooms/${room.id}/private/${downstream.id}/run`, { version: 1 }, owner)).status, 200);
  assert.equal(JSON.parse(sent.body).prompt, "private improved prompt");
  assert.ok(!JSON.stringify((await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body).includes("private improved prompt"));
  assert.equal(atPath({}, "constructor.name"), undefined);
  assert.throws(() => renderJson('{"x":"{{input.__proto__.secret}}"}', { input: {} }), /缺少输入/);
});

test("private connections never disclose results, including to the room owner, until explicit publication", async (t) => {
  const f = await fixture(t, {}, { executeRequest: async () => ({ status: 200, text: '{"safe":"publish this","secret":"keep private"}' }) });
  const owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), editor);
  const p = privateNode(), publicNode = custom(), otherPrivate = privateNode();
  await f.send(room.id, editor, [{ type: "create", node: p }]);
  await f.send(room.id, owner, [{ type: "create", node: publicNode }, { type: "create", node: otherPrivate }]);
  assert.equal((await f.send(room.id, editor, [{ type: "connect", edge: edge(p, publicNode) }])).status, 403);
  assert.equal((await f.send(room.id, editor, [{ type: "connect", edge: edge(p, otherPrivate) }])).status, 403);
  assert.equal((await f.send(room.id, owner, [{ type: "connect", edge: edge(publicNode, p) }])).status, 403);
  const path = `/api/rooms/${room.id}/private/${p.id}`;
  const result = (await f.request("POST", `${path}/run`, { version: 1 }, editor)).body.result;
  assert.equal((await f.request("POST", `${path}/publish`, { resultId: result.id, version: 1, path: "safe", kind: "text", title: "公开结果" }, owner)).status, 404);
  assert.equal((await f.request("POST", `${path}/publish`, { resultId: "stale", version: 1, path: "safe", kind: "text", title: "公开结果" }, editor)).status, 409);
  const published = await f.request("POST", `${path}/publish`, { resultId: result.id, version: 1, path: "safe", kind: "text", title: "公开结果" }, editor);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const snapshot = (await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body;
  assert.ok(JSON.stringify(snapshot).includes("publish this"));
  assert.ok(!JSON.stringify(snapshot).includes("keep private"));
});

test("templates are reusable, encrypted per account, and omit credentials", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), other = await f.login(await f.user("other"));
  const template = { name: "My private model", kind: "private", privateData: privateData("never-copy-this-key") };
  const created = await f.request("POST", "/api/node-templates", template, owner);
  assert.equal(created.status, 200);
  assert.equal(created.body.privateData.request.apiKey, "");
  const rows = await f.app.context.db.all("SELECT * FROM node_templates");
  assert.ok(!JSON.stringify(rows).includes("My private model"));
  assert.ok(!JSON.stringify(rows).includes("never-copy-this-key"));
  assert.ok(!(await f.request("GET", "/api/node-templates", undefined, other)).body.some((entry) => entry.id === created.body.id));
  assert.equal((await f.request("DELETE", `/api/node-templates/${created.body.id}`, undefined, other)).status, 404);
  const reused = (await f.request("GET", "/api/node-templates", undefined, owner)).body.find((entry) => entry.id === created.body.id);
  const room = await f.room(owner), node = { ...privateNode(), privateData: reused.privateData };
  assert.equal((await f.send(room.id, owner, [{ type: "create", node }])).status, 200);
  const updated = await f.request("PUT", `/api/node-templates/${created.body.id}`, { version: 1, template: { ...template, name: "Updated" } }, owner);
  assert.equal(updated.status, 200);
  assert.equal((await f.request("PUT", `/api/node-templates/${created.body.id}`, { version: 1, template }, owner)).status, 409);
});

test("video task submission and later status queries retain the task ID without resubmitting", async (t) => {
  const requests = [];
  const f = await fixture(t, {}, { executeRequest: async (request) => {
    requests.push(request);
    return { status: 200, text: request.method === "POST" ? '{"data":{"task_id":"job/1?x=2"}}' : '{"data":{"status":"completed","results":[{"url":"https://media.example.com/video.mp4"}]}}' };
  } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const template = (await f.request("GET", "/api/node-templates", undefined, owner)).body.find((entry) => entry.id === "builtin-video");
  const node = { ...privateNode(), privateData: template.privateData };
  await f.send(room.id, owner, [{ type: "create", node }]);
  const path = `/api/rooms/${room.id}/private/${node.id}/run`;
  const submitted = await f.request("POST", path, { version: 1 }, owner);
  assert.equal(submitted.body.result.taskId, "job/1?x=2");
  const polled = await f.request("POST", path, { version: 1, action: "poll" }, owner);
  assert.equal(polled.body.result.taskId, "job/1?x=2");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "GET");
  assert.ok(requests[1].url.endsWith("job%2F1%3Fx%3D2"));
  assert.equal(polled.body.media[0].type, "video");
});

test("connected attachments are encoded as a stream and media previews enforce node ownership", async (t) => {
  let body;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+mQAAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, {}, { executeRequest: async (request) => {
    assert.notEqual(typeof request.body, "string"); body = "";
    for await (const chunk of request.body) body += chunk;
    return { status: 200, text: JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }) };
  } });
  const owner = await f.login(await f.user("owner")), other = await f.login(await f.user("other")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), other);
  const id = randomUUID();
  await saveEncryptedFile(Readable.from([png]), id, f.app.context.key, f.config);
  await f.app.context.db.run("INSERT INTO files(id,room_id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?,?)", [id, room.id, owner.user.id, "image/png", png.length, Date.now()]);
  const image = { ...textNode(), kind: "image", fileId: id }, p = privateNode();
  p.privateData.request.body = '{"image":"{{image.dataUrl}}"}';
  await f.send(room.id, owner, [{ type: "create", node: image }, { type: "create", node: p }, { type: "connect", edge: edge(image, p, "image") }]);
  const path = `/api/rooms/${room.id}/private/${p.id}`;
  const ran = await f.request("POST", `${path}/run`, { version: 1 }, owner);
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(JSON.parse(body).image, `data:image/png;base64,${png.toString("base64")}`);
  const mediaPath = `${path}/media?path=data.0.b64_json&resultId=${ran.body.result.id}`;
  assert.equal((await f.request("GET", mediaPath, undefined, other)).status, 404);
  assert.deepEqual((await f.request("GET", mediaPath, undefined, owner)).response.rawPayload, png);
  const published = await f.request("POST", `${path}/publish`, { resultId: ran.body.result.id, version: 1, path: "data.0.b64_json", kind: "media", title: "发布图片" }, owner);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const shared = published.body.changes[0].node;
  assert.equal(shared.kind, "image");
  assert.deepEqual((await f.request("GET", `/api/rooms/${room.id}/files/${shared.fileId}`, undefined, other)).response.rawPayload, png);
});

test("one running request per private node prevents duplicate provider submissions", async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, {}, { executeRequest: async () => { started(); await gate; return { status: 200, text: "ok" }; } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner), node = privateNode();
  await f.send(room.id, owner, [{ type: "create", node }]);
  const run = () => f.request("POST", `/api/rooms/${room.id}/private/${node.id}/run`, { version: 1 }, owner);
  const first = run(); await ready;
  try { assert.equal((await run()).status, 409); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

test("version 1 databases are backed up before the additive graph migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-migration-")), path = join(root, "canvas.sqlite");
  const original = new DatabaseSync(path);
  original.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('keep-me'); PRAGMA user_version=1");
  original.close();
  const migrated = await openDatabase(path);
  try {
    assert.equal((await migrated.get("PRAGMA user_version")).user_version, 2);
    assert.equal((await migrated.get("SELECT value FROM preserved")).value, "keep-me");
    const backups = (await readdir(root)).filter((name) => name.startsWith("canvas.sqlite.before-v2-"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(root, backups[0]), { readOnly: true });
    assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(backup.prepare("SELECT value FROM preserved").get().value, "keep-me");
    backup.close();
  } finally { await migrated.close(); }
});
