import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fixture } from "./helpers.js";

function cursorEvent(connection, predicate) {
  return new Promise((resolve) => {
    const receive = (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "cursors" && predicate(event.cursors)) { connection.ws.off("message", receive); resolve(event.cursors); }
    };
    connection.ws.on("message", receive);
  });
}

test("cursor names come from authentication and positions stay ephemeral within their room", async (t) => {
  const f = await fixture(t);
  const owner = await f.login(await f.user("owner")), viewer = await f.login(await f.user("viewer")), stranger = await f.login(await f.user("stranger"));
  const room = await f.room(owner), other = await f.room(stranger);
  await f.joinRoom(await f.share(room.id, owner, "viewer"), viewer);
  const first = f.socket(room.id, owner), second = f.socket(room.id, viewer), isolated = f.socket(other.id, stranger);
  await Promise.all([first.ready, second.ready, isolated.ready]);
  const observed = cursorEvent(first, (cursors) => cursors.some((cursor) => cursor.userId === viewer.user.id));
  second.ws.send(JSON.stringify({ type: "cursor", position: { x: 123, y: 456 } }));
  const cursors = await observed;
  assert.deepEqual(cursors.find((cursor) => cursor.userId === viewer.user.id), { userId: viewer.user.id, username: "viewer", position: { x: 123, y: 456 } });
  assert.equal((await f.request("GET", `/api/rooms/${room.id}`, undefined, owner)).body.revision, 0);
  assert.ok(!JSON.stringify(isolated.events).includes(viewer.user.id));
  const cleared = cursorEvent(first, (cursors) => !cursors.some((cursor) => cursor.userId === viewer.user.id));
  second.ws.send(JSON.stringify({ type: "cursor", position: null }));
  await cleared;
  const closed = once(second.ws, "close");
  second.ws.send(JSON.stringify({ type: "cursor", position: { x: 0, y: 0 }, username: "forged-admin" }));
  assert.equal((await closed)[0], 1008);
  assert.ok(!JSON.stringify(first.events).includes("forged-admin"));
  first.ws.close(); isolated.ws.close();
});
