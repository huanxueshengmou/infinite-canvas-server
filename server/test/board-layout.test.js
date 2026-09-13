import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, privateNode, textNode } from "./helpers.js";

const groupNode = () => ({ ...textNode("画布组"), kind: "group", content: "", width: 640, height: 420 });
const whiteboard = () => ({ ...textNode("白板"), kind: "whiteboard", content: "", drawing: [] });
const snapshot = async (f, room, auth) => (await f.request("GET", `/api/rooms/${room.id}`, undefined, auth)).body;
const ok = (result) => assert.equal(result.status, 200, JSON.stringify(result.body));
async function restore(f, room, auth, id, direction, ids) {
  const current = await snapshot(f, room, auth);
  return f.request("POST", `/api/rooms/${room.id}/history/${id}`, { operationId: randomUUID(), direction, nodes: Object.fromEntries(ids.map((id) => [id, current.nodes.find((node) => node.id === id)?.version ?? null])), edges: {} }, auth);
}

test("groups move and dissolve atomically, with undo and redo restoring every member", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const group = groupNode(), a = { ...textNode("a"), groupId: group.id }, b = { ...whiteboard(), groupId: group.id };
  // Relationships are checked against the entire batch, regardless of create order.
  ok(await f.send(room.id, owner, [a, group, b].map((node) => ({ type: "create", node }))));
  const before = await snapshot(f, room, owner), ids = before.nodes.map((node) => node.id);
  const moved = await f.send(room.id, owner, before.nodes.map((node) => ({ type: "update", id: node.id, version: node.version, fields: { position: { x: node.position.x + 120, y: node.position.y + 80 } } })));
  ok(moved);
  ok(await restore(f, room, owner, moved.body.historyId, "undo", ids));
  for (const node of (await snapshot(f, room, owner)).nodes) { assert.deepEqual(node.position, before.nodes.find((item) => item.id === node.id).position); assert.equal(node.version, 3); }
  ok(await restore(f, room, owner, moved.body.historyId, "redo", ids));
  const redone = await snapshot(f, room, owner);
  for (const node of redone.nodes) { assert.deepEqual(node.position, { x: 130, y: 100 }); assert.equal(node.version, 4); }
  const dissolved = await f.send(room.id, owner, [{ type: "delete", id: group.id, version: 4 }, ...[a, b].map((node) => ({ type: "update", id: node.id, version: 4, fields: { groupId: null } }))]);
  ok(dissolved);
  assert.ok((await snapshot(f, room, owner)).nodes.every((node) => !node.groupId && node.kind !== "group"));
  ok(await restore(f, room, owner, dissolved.body.historyId, "undo", ids));
  const restored = (await snapshot(f, room, owner)).nodes;
  assert.equal(restored.length, 3);
  assert.equal(restored.filter((node) => node.groupId === group.id).length, 2);
  const baseline = await snapshot(f, room, owner);
  const stale = await f.send(room.id, owner, restored.map((node, index) => ({ type: "update", id: node.id, version: node.version - Number(index === 1), fields: { position: { x: 999, y: 999 } } })));
  assert.equal(stale.status, 409); assert.deepEqual(await snapshot(f, room, owner), baseline);
});

test("groups reject cross-room IDs, non-groups, nesting and private membership without partial writes", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner), other = await f.room(owner);
  const foreign = groupNode(), group = groupNode(), ordinary = textNode();
  ok(await f.send(other.id, owner, [{ type: "create", node: foreign }]));
  ok(await f.send(room.id, owner, [group, ordinary].map((node) => ({ type: "create", node }))));
  const baseline = await snapshot(f, room, owner);
  for (const node of [
    { ...textNode(), groupId: foreign.id }, { ...textNode(), groupId: ordinary.id },
    { ...groupNode(), groupId: group.id }, { ...privateNode(), groupId: group.id },
  ]) {
    const rejected = await f.send(room.id, owner, [{ type: "update", id: ordinary.id, version: 1, fields: { content: "must roll back" } }, { type: "create", node }]);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.deepEqual(await snapshot(f, room, owner), baseline);
  }
  assert.equal((await f.send(room.id, owner, [{ type: "update", id: ordinary.id, version: 1, fields: { groupId: randomUUID() } }])).status, 400);
  assert.deepEqual(await snapshot(f, room, owner), baseline);
});

test("deleting a group must detach or delete its members and undo restores the complete group", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const group = groupNode(), member = { ...textNode(), groupId: group.id };
  ok(await f.send(room.id, owner, [group, member].map((node) => ({ type: "create", node }))));
  const baseline = await snapshot(f, room, owner);
  assert.equal((await f.send(room.id, owner, [{ type: "delete", id: group.id, version: 1 }])).status, 400);
  assert.deepEqual(await snapshot(f, room, owner), baseline);
  const removed = await f.send(room.id, owner, [group, member].map((node) => ({ type: "delete", id: node.id, version: 1 })));
  ok(removed); assert.equal((await snapshot(f, room, owner)).nodes.length, 0);
  ok(await restore(f, room, owner, removed.body.historyId, "undo", [group.id, member.id]));
  assert.equal((await snapshot(f, room, owner)).nodes.find((node) => node.id === member.id).groupId, group.id);
});

test("undo cannot orphan a collaborator's newly joined member", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), editor = await f.login(await f.user("editor")), room = await f.room(owner);
  ok(await f.joinRoom(await f.share(room.id, owner), editor));
  const group = groupNode(), member = { ...textNode(), groupId: group.id };
  const created = await f.send(room.id, owner, [{ type: "create", node: group }]); ok(created);
  ok(await f.send(room.id, editor, [{ type: "create", node: member }]));
  const baseline = await snapshot(f, room, owner);
  assert.equal((await restore(f, room, owner, created.body.historyId, "undo", [group.id])).status, 409);
  assert.deepEqual(await snapshot(f, room, owner), baseline);
});

test("whiteboard ink and dimensions synchronize and undo together, while viewers cannot write", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), viewer = await f.login(await f.user("viewer")), room = await f.room(owner);
  ok(await f.joinRoom(await f.share(room.id, owner, "viewer"), viewer));
  const board = whiteboard(); ok(await f.send(room.id, owner, [{ type: "create", node: board }]));
  const drawing = [
    { type: "brush", points: [{ x: 1, y: 2 }, { x: 8, y: 10 }], color: "currentColor", size: 4 },
    { type: "arrow", from: { x: 20, y: 20 }, to: { x: 80, y: 60 }, color: "#Ab12EF", size: 3 },
    { type: "text", position: { x: 100, y: 40 }, text: "白板文字\n<script>literal text</script>", color: "#e5484d", size: 24 },
  ];
  const edit = { type: "update", id: board.id, version: 1, fields: { drawing, width: 720, height: 480 } };
  assert.equal((await f.send(room.id, viewer, [edit])).status, 403);
  const changed = await f.send(room.id, owner, [edit]); ok(changed);
  const observer = f.socket(room.id, viewer); await observer.ready; t.after(() => observer.ws.close());
  assert.deepEqual(observer.events.find((event) => event.type === "snapshot-node").node, { ...board, ...edit.fields, version: 2 });
  ok(await restore(f, room, owner, changed.body.historyId, "undo", [board.id]));
  assert.deepEqual((await snapshot(f, room, viewer)).nodes[0], { ...board, version: 3 });
  ok(await restore(f, room, owner, changed.body.historyId, "redo", [board.id]));
  assert.deepEqual((await snapshot(f, room, viewer)).nodes[0].drawing, drawing);
  // Resizing only changes the visible area; ink survives shrinking below its coordinates.
  ok(await f.send(room.id, owner, [{ type: "update", id: board.id, version: 4, fields: { width: 1, height: 1 } }]));
  assert.deepEqual((await snapshot(f, room, viewer)).nodes[0].drawing, drawing);
});

test("whiteboard drawing schema rejects active content, malformed coordinates and use on other node kinds", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner), board = whiteboard(), text = textNode();
  ok(await f.send(room.id, owner, [board, text].map((node) => ({ type: "create", node }))));
  const brush = { type: "brush", points: [{ x: 1, y: 2 }], color: "#e5484d", size: 4 };
  const baseline = await snapshot(f, room, owner);
  for (const mark of [
    { ...brush, color: "url(https://example.com/track)" }, { ...brush, points: [] },
    { ...brush, size: 0 }, { ...brush, points: [{ x: Infinity, y: 1 }] },
    { ...brush, onclick: "alert(1)" }, { type: "html", text: "<iframe>" },
  ]) assert.equal((await f.send(room.id, owner, [{ type: "update", id: board.id, version: 1, fields: { drawing: [mark] } }])).status, 400);
  assert.equal((await f.send(room.id, owner, [{ type: "update", id: text.id, version: 1, fields: { drawing: [brush] } }])).status, 400);
  assert.equal((await f.send(room.id, owner, [{ type: "create", node: { ...groupNode(), drawing: [] } }])).status, 400);
  assert.deepEqual(await snapshot(f, room, owner), baseline);
});

test("whiteboards and groups have neither input nor output connections", async (t) => {
  const f = await fixture(t), owner = await f.login(await f.user("owner")), room = await f.room(owner);
  const board = whiteboard(), group = groupNode(), source = textNode(), target = { ...textNode(), kind: "custom", outputType: "text" };
  ok(await f.send(room.id, owner, [board, group, source, target].map((node) => ({ type: "create", node }))));
  for (const [from, to] of [[board, target], [group, target], [source, board], [source, group]]) {
    const result = await f.send(room.id, owner, [{ type: "connect", edge: { id: randomUUID(), source: from.id, sourcePort: "output", target: to.id, targetPort: "input" } }]);
    assert.equal(result.status, 400); assert.match(result.body.error, /没有输入或输出端口/);
  }
  assert.equal((await snapshot(f, room, owner)).edges.length, 0);
});
