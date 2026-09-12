import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readdir } from "node:fs/promises";
import { fixture, privateNode, textNode } from "./helpers.js";
import { saveEncryptedFile } from "../src/storage.js";
import { FileInput } from "../src/workflow.js";
import { prepareRequest } from "../src/request-body.js";
import { outgoingHeaders, requestSchema } from "../src/request-config.js";

test("request routes serialize JSON, repeated form fields and text/XML for all supported HTTP methods", async (t) => {
  let sent;
  const f = await fixture(t, {}, { executeRequest: async (request) => { sent = request; return { status: 200, text: "ok" }; } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner), node = privateNode();
  node.privateData.fields = [{ name: "count", label: "Count", type: "number", value: 2 }, { name: "prompt", label: "Prompt", type: "text", value: "中文 & a=b" }];
  await f.send(room.id, owner, [{ type: "create", node }]);
  const path = `/api/rooms/${room.id}/private/${node.id}`;
  let version = 1;
  const cases = [
    { method: "POST", bodyFormat: "json", body: '{"count":"{{params.count}}","optional":"{{image.dataUrl?}}"}', expected: '{"count":2}', mime: "application/json" },
    { method: "PUT", bodyFormat: "urlencoded", body: '{"prompt":"{{params.prompt}}","tag":["one","two"],"count":"{{params.count}}"}', expected: "prompt=%E4%B8%AD%E6%96%87+%26+a%3Db&tag=one&tag=two&count=2", mime: "application/x-www-form-urlencoded" },
    { method: "PATCH", bodyFormat: "text", contentType: "application/xml; charset=utf-8", body: '<request count="{{params.count}}"/>', expected: '<request count="2"/>', mime: "application/xml;charset=utf-8" },
    { method: "DELETE", bodyFormat: "json", body: '{"count":"{{params.count}}"}', expected: '{"count":2}', mime: "application/json" },
    { method: "OPTIONS", bodyFormat: "text", body: "count={{params.count}}", expected: "count=2", mime: "text/plain;charset=utf-8" },
    { method: "GET", bodyFormat: "json", body: "deliberately not valid JSON", expected: "", mime: undefined },
    { method: "HEAD", bodyFormat: "text", body: "must not be sent", expected: "", mime: undefined },
  ];
  for (const entry of cases) {
    const { expected, mime, ...format } = entry;
    const data = { ...node.privateData, request: { ...node.privateData.request, url: "https://api.example.com/?query={{params.prompt}}", ...format, headers: [{ name: "api-version", value: "2026", secret: false }] } };
    const saved = await f.request("PUT", path, { version, data }, owner);
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); version = saved.body.version;
    const run = await f.request("POST", `${path}/run`, { version }, owner);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(sent.method, entry.method);
    assert.equal(sent.body, expected);
    assert.equal(sent.contentType, mime);
    assert.equal(new URL(sent.url).searchParams.get("query"), "中文 & a=b");
    assert.equal(outgoingHeaders(sent)["api-version"], "2026");
    assert.equal(outgoingHeaders(sent).authorization, `Bearer ${node.privateData.request.apiKey}`);
  }
});

test("multipart requests stream real encrypted attachments, preserve repeated fields and declare their exact byte length", async (t) => {
  const bytes = Buffer.alloc(65537); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  let parsed;
  const f = await fixture(t, {}, { executeRequest: async (request) => {
    assert.notEqual(typeof request.body, "string");
    const chunks = []; for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
    const encoded = Buffer.concat(chunks), headers = outgoingHeaders(request);
    assert.equal(headers["content-length"], encoded.length);
    assert.equal(headers["transfer-encoding"], undefined);
    parsed = await new Response(encoded, { headers }).formData();
    return { status: 200, text: "received" };
  } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner), id = randomUUID();
  await saveEncryptedFile(Readable.from([bytes]), id, f.app.context.key, f.config);
  await f.app.context.db.run("INSERT INTO files(id,room_id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?,?)", [id, room.id, owner.user.id, "image/png", bytes.length, Date.now()]);
  const image = { ...textNode("image.png"), kind: "image", fileId: id }, node = privateNode();
  node.privateData.request.bodyFormat = "multipart";
  node.privateData.request.method = "PATCH";
  node.privateData.request.body = '{"prompt":"中文 prompt","image":"{{image.dataUrl}}","tag":["one","two"],"options":{"seed":42}}';
  await f.send(room.id, owner, [{ type: "create", node: image }, { type: "create", node }, { type: "connect", edge: { id: randomUUID(), source: image.id, sourcePort: "output", target: node.id, targetPort: "image" } }]);
  const run = await f.request("POST", `/api/rooms/${room.id}/private/${node.id}/run`, { version: 1 }, owner);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(parsed.get("prompt"), "中文 prompt");
  assert.deepEqual(parsed.getAll("tag"), ["one", "two"]);
  assert.equal(parsed.get("options"), '{"seed":42}');
  assert.equal(parsed.get("image").type, "image/png");
  assert.deepEqual(Buffer.from(await parsed.get("image").arrayBuffer()), bytes);
  assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("download-")), []);
});

test("multipart cancellation and an early provider rejection close streams and remove authenticated file caches", async (t) => {
  const f = await fixture(t), bytes = Buffer.alloc(4 * 1048576, 73), id = randomUUID(), key = f.app.context.key;
  await saveEncryptedFile(Readable.from([bytes]), id, key, f.config);
  const request = requestSchema.parse({ ...privateNode().privateData.request, bodyFormat: "multipart", body: '{"file":"{{image.dataUrl}}"}' });
  const context = { image: { dataUrl: new FileInput({ id, mime: "image/png", size: bytes.length }) } };
  // Closing before a provider starts reading must also finish every queued attachment stream.
  const early = prepareRequest(request, context, key, f.config, new AbortController().signal);
  await early.cleanup();
  assert.equal(early.outgoing.body.destroyed, true);
  const controller = new AbortController(), active = prepareRequest(request, context, key, f.config, controller.signal);
  const iterator = active.outgoing.body[Symbol.asyncIterator]();
  let received = 0;
  while (received < 1024) { const part = await iterator.next(); assert.equal(part.done, false); received += part.value.length; }
  controller.abort();
  await active.cleanup();
  assert.equal(active.outgoing.body.destroyed, true);
  assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith("download-")), []);
});

test("multipart forms containing only text fields or no fields complete and have valid boundaries", async () => {
  for (const body of ['{"tag":["one","two"],"title":"中文"}', '{}']) {
    const request = requestSchema.parse({ ...privateNode().privateData.request, bodyFormat: "multipart", body });
    const prepared = prepareRequest(request, {}, null, {}, new AbortController().signal);
    try {
      const chunks = []; for await (const chunk of prepared.outgoing.body) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      assert.equal(encoded.length, prepared.outgoing.contentLength);
      const form = await new Response(encoded, { headers: outgoingHeaders(prepared.outgoing) }).formData();
      if (body === '{}') assert.deepEqual([...form], []);
      else { assert.deepEqual(form.getAll("tag"), ["one", "two"]); assert.equal(form.get("title"), "中文"); }
    } finally { await prepared.cleanup(); }
  }
});

test("request validation rejects header injection, reserved transport fields and duplicate credentials", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner), node = privateNode();
  await f.send(room.id, owner, [{ type: "create", node }]);
  const path = `/api/rooms/${room.id}/private/${node.id}`;
  const invalid = [
    ...["Host", "Cookie", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "X-Forwarded-For", "Proxy-Authorization"].map((name) => ({ headers: [{ name, value: "value" }] })),
    { apiKey: "key\r\nInjected: true" }, { headers: [{ name: "x-token", value: "value\ninjected" }] },
    { headers: [{ name: "x-token", value: "one" }, { name: "X-Token", value: "two" }] },
    { method: "TRACE" }, { contentType: "not a MIME type" },
  ];
  for (const patch of invalid) assert.equal((await f.request("PUT", path, { version: 1, data: { ...node.privateData, request: { ...node.privateData.request, ...patch } } }, owner)).status, 400);
  assert.equal((await f.request("GET", path, undefined, owner)).body.version, 1);
  const request = requestSchema.parse(node.privateData.request);
  assert.equal(outgoingHeaders({ ...request, header: "authorization" }).authorization, `Bearer ${request.apiKey}`);
  assert.equal(outgoingHeaders({ ...request, apiKey: "Basic dXNlcjpwYXNz", authMode: "raw" }).authorization, "Basic dXNlcjpwYXNz");
  assert.equal(outgoingHeaders({ ...request, header: "x-goog-api-key" })["x-goog-api-key"], request.apiKey);
  assert.equal(outgoingHeaders({ ...request, authMode: "none" }).authorization, undefined);
  assert.throws(() => outgoingHeaders({ ...request, headers: [{ name: "authorization", value: "another" }] }), /重复/);
  assert.equal(outgoingHeaders({ ...request, method: "DELETE", body: Readable.from(["{}"]), contentType: "application/json" })["transfer-encoding"], "chunked");
});

test("saved templates clear API keys and secret headers while retaining explicitly public header values", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), data = privateNode().privateData;
  data.request.headers = [{ name: "x-token", value: "secret-header-value" }, { name: "api-version", value: "2026-09", secret: false }];
  const template = { name: "Format template", kind: "private", privateData: data };
  const created = await f.request("POST", "/api/node-templates", template, owner);
  assert.equal(created.status, 200);
  const check = (entry) => { assert.equal(entry.privateData.request.apiKey, ""); assert.equal(entry.privateData.request.headers[0].value, ""); assert.equal(entry.privateData.request.headers[1].value, "2026-09"); };
  check(created.body);
  const updated = await f.request("PUT", `/api/node-templates/${created.body.id}`, { version: 1, template }, owner);
  assert.equal(updated.status, 200);
  check((await f.request("GET", "/api/node-templates", undefined, owner)).body.find((entry) => entry.id === created.body.id));
  assert.ok(!JSON.stringify(await f.app.context.db.all("SELECT * FROM node_templates")).includes("secret-header-value"));
});

test("file inputs cannot accidentally become strings in URL encoded forms or raw text bodies", () => {
  const data = privateNode().privateData.request, context = { image: { dataUrl: new FileInput({ id: randomUUID() }) } };
  for (const bodyFormat of ["urlencoded", "text"]) assert.throws(() => prepareRequest({ ...data, bodyFormat, body: bodyFormat === "text" ? "{{image.dataUrl}}" : '{"image":"{{image.dataUrl}}"}' }, context, null, {}, new AbortController().signal), /附件/);
});
