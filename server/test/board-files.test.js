import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import contentDisposition from "content-disposition";
import { fixture, privateNode, textNode } from "./helpers.js";

async function upload(f, room, auth, name, mime = "application/octet-stream", data = "file bytes") {
  const form = new FormData(); form.append("file", new Blob([data], { type: mime }), name);
  const request = new Request("http://localhost/upload", { method: "POST", body: form });
  return f.request("POST", `/api/rooms/${room.id}/files`, Buffer.from(await request.arrayBuffer()), auth, { "content-type": request.headers.get("content-type") });
}

test("file imports wait for existing transfer capacity without blocking canvas edits", async (t) => {
  let release, started = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, {}, { executeRequest: async () => { started++; await gate; return { status: 200, text: "ok" }; } });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner), privateNodes = [privateNode(), privateNode()];
  await f.send(room.id, owner, privateNodes.map((node) => ({ type: "create", node })));
  const running = privateNodes.map((node) => f.request("POST", `/api/rooms/${room.id}/private/${node.id}/run`, { version: 1 }, owner));
  while (started < f.config.API_CONCURRENCY) await new Promise((resolve) => setImmediate(resolve));
  let completed = false;
  const pending = upload(f, room, owner, "queued.png").then((result) => { completed = true; return result; });
  try {
    assert.equal((await f.request("GET", "/health")).status, 200);
    assert.equal((await f.send(room.id, owner, [{ type: "create", node: textNode() }])).status, 200);
    assert.equal(completed, false);
  } finally { release(); }
  assert.ok((await Promise.all(running)).every((result) => result.status === 200));
  const stored = await pending;
  assert.equal(stored.status, 200); assert.equal(stored.body.mime, "image/png");
});

test("uploaded suffixes determine media previews and unsupported files stay download-only", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  for (const [name, claimed, expected] of [
    ["photo.PNG", "", "image/png"], ["photo.jpeg", "application/octet-stream", "image/jpeg"],
    ["photo.webp", "image/png", "image/webp"], ["animation.gif", "image/gif", "image/gif"],
    ["movie.MP4", "", "video/mp4"], ["movie.webm", "application/octet-stream", "video/webm"],
    ["audio.mp3", "audio/mpeg", "audio/mpeg"],
    ["photo.unknown", "image/png", "application/octet-stream"], ["movie.mov", "video/mp4", "application/octet-stream"],
    ["page.html", "image/png", "application/octet-stream"], ["picture.svg", "image/png", "application/octet-stream"],
    ["notes.md", "text/markdown", "application/octet-stream"], ["document.pdf", "image/png", "application/octet-stream"],
    ["archive.zip", "video/mp4", "application/octet-stream"], ["no-extension", "image/png", "application/octet-stream"],
  ]) {
    const stored = await upload(f, room, owner, name, claimed);
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    assert.equal(stored.body.mime, expected, name);
    const downloaded = await f.request("GET", `/api/rooms/${room.id}/files/${stored.body.id}`, undefined, owner);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body, "file bytes");
    assert.equal(downloaded.response.headers["content-type"], expected);
    assert.equal(contentDisposition.parse(downloaded.response.headers["content-disposition"]).type, expected === "application/octet-stream" ? "attachment" : "inline");
    assert.equal(downloaded.response.headers["x-content-type-options"], "nosniff");
    if (expected === "application/octet-stream") {
      const forged = { ...textNode(), kind: "image", fileId: stored.body.id };
      assert.equal((await f.send(room.id, owner, [{ type: "create", node: forged }])).status, 400);
      assert.equal((await f.send(room.id, owner, [{ type: "create", node: { ...forged, kind: "file" } }])).status, 200);
    }
  }
});

test("downloads keep Unicode filenames, sanitize header characters and enforce room permissions", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), viewer = await f.login(await f.user("viewer")), stranger = await f.login(await f.user("stranger"));
  const room = await f.room(owner), other = await f.room(stranger);
  await f.joinRoom(await f.share(room.id, owner, "viewer"), viewer);
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  const stored = await upload(f, room, owner, "photo.png", "image/png", bytes);
  assert.equal(stored.status, 200);
  const path = `/api/rooms/${room.id}/files/${stored.body.id}`;
  for (const filename of ['图片 【原图】 "一".png', "video 100%.mp4", "../folder\\evil\r\nheader.png"]) {
    const result = await f.request("GET", `${path}?${new URLSearchParams({ download: filename })}`, undefined, viewer);
    assert.equal(result.status, 200);
    const disposition = contentDisposition.parse(result.response.headers["content-disposition"]);
    assert.equal(disposition.type, "attachment");
    assert.equal(disposition.parameters.filename, filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_"));
    assert.deepEqual(result.response.rawPayload, Buffer.from(bytes));
    assert.equal(result.response.headers["content-length"], String(bytes.length));
  }
  assert.equal((await f.request("GET", path)).status, 401);
  assert.equal((await f.request("GET", path, undefined, stranger)).status, 404);
  assert.equal((await f.request("GET", `/api/rooms/${other.id}/files/${stored.body.id}`, undefined, stranger)).status, 404);
  assert.equal((await upload(f, room, viewer, "read-only.png")).status, 403);
  assert.equal((await f.request("GET", `${path}?download=a&download=b`, undefined, owner)).status, 400);
  const unsupported = await upload(f, room, owner, "renamed.dat", "image/png");
  const image = { ...textNode(), kind: "image", fileId: stored.body.id };
  assert.equal((await f.send(room.id, owner, [{ type: "create", node: image }])).status, 200);
  assert.equal((await f.send(room.id, owner, [{ type: "update", id: image.id, version: 1, fields: { fileId: unsupported.body.id } }])).status, 400);
  assert.equal((await f.send(other.id, stranger, [{ type: "create", node: { ...image, id: randomUUID() } }])).status, 400);
});

test("Markdown nodes synchronize, feed text inputs, restore edits and reject viewer writes", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), viewer = await f.login(await f.user("viewer"));
  const room = await f.room(owner); await f.joinRoom(await f.share(room.id, owner, "viewer"), viewer);
  const markdown = { ...textNode("文档.md"), kind: "markdown", content: "# 标题\n\n**正文**\n\n- [x] 完成" };
  const target = { ...textNode("文本拼接"), kind: "custom", outputType: "text", content: "{{input.text}}" };
  const edge = { id: randomUUID(), source: markdown.id, sourcePort: "output", target: target.id, targetPort: "input" };
  const created = await f.send(room.id, owner, [{ type: "create", node: markdown }, { type: "create", node: target }, { type: "connect", edge }]);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const socket = f.socket(room.id, viewer); await socket.ready; t.after(() => socket.ws.close());
  assert.deepEqual(socket.events.find((event) => event.type === "snapshot-node" && event.node.id === markdown.id).node, { ...markdown, version: 1 });
  const evaluation = await f.request("POST", `/api/rooms/${room.id}/nodes/${target.id}/evaluate`, {}, owner);
  assert.equal(evaluation.status, 200); assert.equal(evaluation.body.text, markdown.content);
  const edit = { type: "update", id: markdown.id, version: 1, fields: { content: "## 修改后的正文" } };
  assert.equal((await f.send(room.id, viewer, [edit])).status, 403);
  const changed = await f.send(room.id, owner, [edit]); assert.equal(changed.status, 200);
  const undone = await f.request("POST", `/api/rooms/${room.id}/history/${changed.body.historyId}`, { operationId: randomUUID(), direction: "undo", nodes: { [markdown.id]: 2 }, edges: {} }, owner);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const restored = (await f.request("GET", `/api/rooms/${room.id}`, undefined, viewer)).body.nodes.find((node) => node.id === markdown.id);
  assert.equal(restored.kind, "markdown"); assert.equal(restored.content, markdown.content); assert.equal(restored.version, 3);
});

test("edited images replace one node, retain downloadable originals and support guarded undo", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const original = await upload(f, room, owner, "original.png", "image/png", "original image bytes");
  const edited = await upload(f, room, owner, "edited.png", "image/png", "edited image bytes");
  assert.equal(original.status, 200); assert.equal(edited.status, 200);
  const a = { ...textNode("original.png"), kind: "image", fileId: original.body.id }, b = { ...a, id: randomUUID() };
  assert.equal((await f.send(room.id, owner, [a, b].map((node) => ({ type: "create", node })))).status, 200);
  const changed = await f.send(room.id, owner, [{ type: "update", id: a.id, version: 1, fields: { fileId: edited.body.id, title: "edited.png" } }]);
  assert.equal(changed.status, 200);
  const current = (await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body;
  assert.equal(current.nodes.find((node) => node.id === a.id).fileId, edited.body.id);
  assert.equal(current.nodes.find((node) => node.id === b.id).fileId, original.body.id);
  assert.equal((await f.send(room.id, owner, [{ type: "update", id: a.id, version: 1, fields: { fileId: original.body.id } }])).status, 409);
  for (const [file, bytes] of [[original, "original image bytes"], [edited, "edited image bytes"]]) {
    const downloaded = await f.request("GET", `/api/rooms/${room.id}/files/${file.body.id}?download=image.png`, undefined, owner);
    assert.equal(downloaded.status, 200); assert.equal(downloaded.body, bytes);
  }
  const undone = await f.request("POST", `/api/rooms/${room.id}/history/${changed.body.historyId}`, { operationId: randomUUID(), direction: "undo", nodes: { [a.id]: 2 }, edges: {} }, owner);
  assert.equal(undone.status, 200);
  assert.ok((await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body.nodes.every((node) => node.fileId === original.body.id));
  for (const kind of ["whiteboard", "group"]) assert.equal((await f.send(room.id, owner, [{ type: "create", node: { ...textNode(), kind, fileId: original.body.id } }])).status, 400);
});
