import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, textNode, privateNode, privateData } from "./helpers.js";

const custom = () => ({ ...textNode(), kind: "custom", outputType: "text" });
const link = (source, target) => ({ id: randomUUID(), source: source.id, sourcePort: "output", target: target.id, targetPort: "input" });
const snapshot = async (f, room, auth) => (await f.request("GET", `/api/rooms/${room.id}`, undefined, auth)).body;
async function history(f, room, auth, id, direction, nodes = [], edges = [], operationId = randomUUID()) {
  const current = await snapshot(f, room, auth);
  const body = { operationId, direction, nodes: Object.fromEntries(nodes.map((id) => [id, current.nodes.find((node) => node.id === id)?.version ?? null])), edges: Object.fromEntries(edges.map((id) => [id, current.edges.find((edge) => edge.id === id)?.version ?? null])) };
  return f.request("POST", `/api/rooms/${room.id}/history/${id}`, body, auth);
}

test("grouped multi-node drags undo and redo atomically with increasing versions and idempotent receipts", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const a = textNode("a"), b = textNode("b"), id = randomUUID();
  await f.send(room.id, owner, [a, b].map((node) => ({ type: "create", node })));
  for (const version of [1, 2]) {
    const result = await f.request("POST", `/api/rooms/${room.id}/operations`, { operationId: randomUUID(), historyId: id, operations: [a, b].map((node) => ({ type: "update", id: node.id, version, fields: { position: { x: version * 100, y: version * 200 } } })) }, owner);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.historyId, id);
  }
  const undoId = randomUUID(), undone = await history(f, room, owner, id, "undo", [a.id, b.id], [], undoId);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  for (const node of (await snapshot(f, room, owner)).nodes) { assert.deepEqual(node.position, a.position); assert.equal(node.version, 4); }
  // A retry carries the original guards, even though the first request already changed the versions.
  const duplicate = await f.request("POST", `/api/rooms/${room.id}/history/${id}`, { operationId: undoId, direction: "undo", nodes: { [a.id]: 3, [b.id]: 3 }, edges: {} }, owner);
  assert.deepEqual(duplicate.body, undone.body);
  assert.equal((await snapshot(f, room, owner)).revision, 4);
  const redone = await history(f, room, owner, id, "redo", [a.id, b.id]);
  assert.equal(redone.status, 200, JSON.stringify(redone.body));
  for (const node of (await snapshot(f, room, owner)).nodes) { assert.deepEqual(node.position, { x: 200, y: 400 }); assert.equal(node.version, 5); }
});

test("deleting and restoring a private node preserves its result and connections without broadcasting secrets", async (t) => {
  const f = await fixture(t, {}, { executeRequest: async () => ({ status: 200, text: "private-history-result" }) });
  const owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), editor);
  const source = textNode(), p = privateNode(), edge = link(source, p);
  await f.send(room.id, editor, [{ type: "create", node: source }, { type: "create", node: p }, { type: "connect", edge }]);
  const path = `/api/rooms/${room.id}/private/${p.id}`;
  assert.equal((await f.request("POST", `${path}/run`, { version: 1 }, editor)).status, 200);
  const observer = f.socket(room.id, owner); await observer.ready; t.after(() => observer.ws.close());
  const removed = await f.send(room.id, editor, [{ type: "delete", id: p.id, version: 1 }]);
  assert.equal((await snapshot(f, room, editor)).edges.length, 0);
  for (const direction of ["undo", "redo", "undo"]) {
    const result = await history(f, room, editor, removed.body.historyId, direction, [p.id], [edge.id]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(!JSON.stringify(result.body).includes("Confidential"));
  }
  const restored = (await f.request("GET", path, undefined, editor)).body;
  assert.equal(restored.data.request.apiKey, p.privateData.request.apiKey);
  assert.equal(restored.result.text, "private-history-result");
  assert.equal(restored.result.configVersion, restored.version);
  assert.equal((await snapshot(f, room, editor)).edges.length, 1);
  assert.equal((await f.request("GET", path, undefined, owner)).status, 404);
  const rawHistory = await f.app.context.db.all("SELECT * FROM operation_history");
  for (const secret of [p.privateData.request.apiKey, "Confidential", "private-history-result"]) {
    assert.ok(!JSON.stringify(rawHistory).includes(secret));
    assert.ok(!JSON.stringify(observer.events).includes(secret));
    assert.ok(!JSON.stringify(await snapshot(f, room, owner)).includes(secret));
  }
});

test("undo refuses stale guards and conflicting collaborator changes without partially rolling back a batch", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), editor);
  const a = textNode("a"), b = textNode("b");
  await f.send(room.id, owner, [a, b].map((node) => ({ type: "create", node })));
  const moved = await f.send(room.id, owner, [a, b].map((node) => ({ type: "update", id: node.id, version: 1, fields: { position: { x: 100, y: 100 } } })));
  await f.send(room.id, editor, [{ type: "update", id: a.id, version: 2, fields: { position: { x: 777, y: 888 } } }]);
  const before = await snapshot(f, room, owner);
  const stale = await f.request("POST", `/api/rooms/${room.id}/history/${moved.body.historyId}`, { operationId: randomUUID(), direction: "undo", nodes: { [a.id]: 2, [b.id]: 2 }, edges: {} }, owner);
  assert.equal(stale.status, 409);
  assert.equal((await history(f, room, owner, moved.body.historyId, "undo", [a.id, b.id])).status, 409);
  assert.deepEqual(await snapshot(f, room, owner), before);
});

test("undo cannot discard a collaborator's new connection or restore a now occupied input", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), editor);
  const source = textNode(), target = custom(), other = textNode();
  await f.send(room.id, owner, [{ type: "create", node: source }, { type: "create", node: other }]);
  const created = await f.send(room.id, owner, [{ type: "create", node: target }]), edge = link(source, target);
  await f.send(room.id, editor, [{ type: "connect", edge }]);
  assert.equal((await history(f, room, owner, created.body.historyId, "undo", [target.id])).status, 409);
  const disconnected = await f.send(room.id, owner, [{ type: "disconnect", id: edge.id, version: 1 }]);
  const replacement = link(other, target);
  await f.send(room.id, editor, [{ type: "connect", edge: replacement }]);
  assert.equal((await history(f, room, owner, disconnected.body.historyId, "undo", [], [edge.id])).status, 409);
  assert.deepEqual((await snapshot(f, room, owner)).edges.map((edge) => edge.id), [replacement.id]);
});

test("history is scoped to the acting account and rechecks current membership and editor access", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner", true)), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  const invite = await f.share(room.id, owner); await f.joinRoom(invite, editor);
  const node = textNode(), created = await f.send(room.id, editor, [{ type: "create", node }]);
  assert.equal((await history(f, room, owner, created.body.historyId, "undo", [node.id])).status, 404);
  const action = { operationId: randomUUID(), direction: "undo", nodes: { [node.id]: 1 }, edges: {} };
  assert.equal((await f.request("POST", `/api/rooms/${room.id}/history/${created.body.historyId}`, action, editor, { "x-csrf-token": "wrong" })).status, 403);
  await f.app.context.db.run("UPDATE members SET role='viewer' WHERE room_id=? AND user_id=?", [room.id, editor.user.id]);
  assert.equal((await history(f, room, editor, created.body.historyId, "undo", [node.id])).status, 403);
  await f.request("DELETE", `/api/rooms/${room.id}/shares/${invite.id}`, undefined, owner);
  assert.equal((await f.request("POST", `/api/rooms/${room.id}/history/${created.body.historyId}`, action, editor)).status, 404);
  assert.equal((await snapshot(f, room, owner)).nodes.length, 1);
});

test("undoing a private placeholder move preserves newer configuration and API results", async (t) => {
  const f = await fixture(t, {}, { executeRequest: async () => ({ status: 200, text: "new-result" }) });
  const owner = await f.login(await f.user("owner")), room = await f.room(owner), node = privateNode();
  const created = await f.send(room.id, owner, [{ type: "create", node }]);
  const moved = await f.send(room.id, owner, [{ type: "update", id: node.id, version: 1, fields: { position: { x: 90, y: 80 } } }]);
  const path = `/api/rooms/${room.id}/private/${node.id}`;
  await f.request("PUT", path, { version: 1, data: privateData("new-key") }, owner);
  await f.request("POST", `${path}/run`, { version: 2 }, owner);
  const before = (await f.request("GET", path, undefined, owner)).body;
  assert.equal((await history(f, room, owner, moved.body.historyId, "undo", [node.id])).status, 200);
  assert.deepEqual((await f.request("GET", path, undefined, owner)).body, before);
  assert.deepEqual((await snapshot(f, room, owner)).nodes[0].position, node.position);
  assert.equal((await history(f, room, owner, created.body.historyId, "undo", [node.id])).status, 409);
});

test("history cannot reconnect to another account's private node reusing a deleted id", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  await f.joinRoom(await f.share(room.id, owner), editor);
  const source = textNode(), p = privateNode(), edge = link(source, p);
  await f.send(room.id, owner, [{ type: "create", node: source }, { type: "create", node: p }, { type: "connect", edge }]);
  const removed = await f.send(room.id, owner, [{ type: "disconnect", id: edge.id, version: 1 }]);
  await f.send(room.id, owner, [{ type: "delete", id: p.id, version: 1 }]);
  assert.equal((await f.send(room.id, editor, [{ type: "create", node: p }])).status, 200);
  assert.equal((await history(f, room, owner, removed.body.historyId, "undo", [], [edge.id])).status, 403);
  assert.equal((await snapshot(f, room, owner)).edges.length, 0);
});
