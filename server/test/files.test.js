import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import { getConfig } from "../src/config.js";
import { executePrivateRequest } from "../src/egress.js";

test("administrators can persist upload limits without restricting existing downloads", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(await f.user("administrator", true)), member = await f.login(await f.user("member"));
  const room = await f.room(member), MiB = 1048576;
  assert.equal((await f.request("GET", "/api/meta")).body.maxFileBytes, 500 * MiB);
  assert.equal((await f.request("PUT", "/api/admin/settings", { maxFileBytes: MiB }, member)).status, 403);
  assert.equal((await f.request("PUT", "/api/admin/settings", { maxFileBytes: 0 }, admin)).status, 400);
  assert.equal((await f.request("PUT", "/api/admin/settings", { maxFileBytes: MiB }, admin)).status, 200);
  assert.equal((await f.request("GET", "/api/meta")).body.maxFileBytes, MiB);
  assert.equal(JSON.parse((await f.app.context.db.get("SELECT value FROM settings WHERE key='max_file_bytes'")).value), MiB);
  const upload = async (size) => {
    const boundary = randomUUID();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.alloc(size, 65), Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return f.request("POST", `/api/rooms/${room.id}/files`, body, member, { "content-type": `multipart/form-data; boundary=${boundary}` });
  };
  const exact = await upload(MiB);
  assert.equal(exact.status, 200);
  assert.equal(exact.body.size, MiB);
  assert.equal((await upload(MiB + 1)).status, 413);
  assert.equal((await f.request("PUT", "/api/admin/settings", { maxFileBytes: 2 * MiB }, admin)).status, 200);
  const larger = await upload(MiB + 1);
  assert.equal(larger.status, 200);
  assert.equal((await f.request("PUT", "/api/admin/settings", { maxFileBytes: MiB }, admin)).status, 200);
  const downloaded = await f.request("GET", `/api/rooms/${room.id}/files/${larger.body.id}`, undefined, member);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.response.rawPayload.length, MiB + 1);
  assert.ok(downloaded.response.rawPayload.equals(Buffer.alloc(MiB + 1, 65)));
});

test("file limits do not raise the separately bounded API response limit", async (t) => {
  const config = getConfig({ MAX_API_RESPONSE_BYTES: 8 });
  assert.equal(getConfig().MAX_API_RESPONSE_BYTES, 20 * 1048576);
  assert.equal(config.MAX_FILE_BYTES, 500 * 1048576);
  let responseSize = 8;
  t.mock.method(https, "request", (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([Buffer.alloc(responseSize, 65)]);
      response.statusCode = 200;
      callback(response);
    };
    return request;
  });
  const request = { url: "https://8.8.8.8/", method: "GET", apiKey: "", header: "Authorization", body: "" };
  const settings = { ...config, allowedHosts: ["8.8.8.8"] }, signal = new AbortController().signal;
  assert.equal((await executePrivateRequest(request, settings, signal)).text, "AAAAAAAA");
  responseSize = 9;
  await assert.rejects(executePrivateRequest(request, settings, signal), /API 响应超过大小限制/);
});
