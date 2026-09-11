import test from "node:test";
import assert from "node:assert/strict";
import { fixture, textNode, privateNode } from "./helpers.js";

test("self-registration starts a normal session without granting access to existing canvases", async (t) => {
  const f = await fixture(t);
  const owner = await f.login(await f.user("owner", true));
  const existing = await f.room(owner), secret = privateNode();
  assert.equal((await f.send(existing.id, owner, [{ type: "create", node: secret }])).status, 200);
  const credentials = { username: "NewMember", password: "self-registration-password" };
  const result = await f.request("POST", "/api/auth/register", credentials);
  assert.equal(result.status, 200);
  assert.equal(result.body.user.username, "newmember");
  assert.equal(result.body.user.admin, false);
  assert.equal(result.body.roomId, undefined);
  const member = { ...result.body, cookie: result.response.headers["set-cookie"].split(";")[0] };
  assert.equal((await f.request("GET", "/api/auth/session", undefined, member)).body.user.id, member.user.id);
  assert.deepEqual((await f.request("GET", "/api/rooms", undefined, member)).body, []);
  assert.equal((await f.request("GET", `/api/rooms/${existing.id}`, undefined, member)).status, 404);
  assert.equal((await f.request("GET", `/api/rooms/${existing.id}/private/${secret.id}`, undefined, member)).status, 404);
  assert.equal((await f.send(existing.id, member, [{ type: "create", node: textNode() }])).status, 404);
  assert.equal((await f.request("GET", "/api/admin/providers", undefined, member)).status, 403);
  const own = await f.request("POST", "/api/rooms", { title: "My canvas" }, member);
  assert.equal(own.status, 200);
  assert.equal(own.body.role, "owner");
  assert.deepEqual((await f.request("GET", "/api/rooms", undefined, member)).body.map((room) => room.id), [own.body.id]);
  assert.equal((await f.request("POST", "/api/auth/logout", undefined, member)).status, 200);
  assert.equal((await f.login(credentials)).user.id, member.user.id);
});

test("simultaneous registrations of the same name cannot overwrite an account", async (t) => {
  const f = await fixture(t);
  const credentials = ["NewMember", "newmember", "NEWMEMBER"].map((username, index) => ({ username, password: `registration-password-${index}` }));
  const results = await Promise.all(credentials.map((input) => f.request("POST", "/api/auth/register", input)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409, 409]);
  const winner = results.findIndex((result) => result.status === 200);
  assert.equal((await f.login(credentials[winner])).user.id, results[winner].body.user.id);
  for (let index = 0; index < results.length; index++) {
    if (index === winner) continue;
    assert.equal(results[index].body.error, "该用户名无法注册，请换一个名称");
    assert.equal(results[index].response.headers["set-cookie"], undefined);
    assert.equal((await f.request("POST", "/api/auth/login", credentials[index])).status, 401);
  }
});

test("invitation registration still rejects invalid shares and grants only the invited role", async (t) => {
  const f = await fixture(t);
  const owner = await f.login(await f.user("owner", true)), room = await f.room(owner);
  const invite = await f.share(room.id, owner, "viewer", { password: "share-password" });
  const revoked = await f.share(room.id, owner);
  assert.equal((await f.request("DELETE", `/api/rooms/${room.id}/shares/${revoked.id}`, undefined, owner)).status, 200);
  const expired = await f.share(room.id, owner);
  await f.app.context.db.run("UPDATE shares SET expires_at=? WHERE id=?", [Date.now() - 1, expired.id]);
  const invalid = [
    { inviteToken: "", status: 400 },
    { inviteToken: "invalid-invitation", status: 403 },
    { inviteToken: invite.token, invitePassword: "wrong-password", status: 403 },
    { inviteToken: revoked.token, status: 403 },
    { inviteToken: expired.token, status: 403 },
  ];
  for (const [index, { status, ...input }] of invalid.entries()) {
    const username = `rejected-${index}`;
    const result = await f.request("POST", "/api/auth/register", { username, password: "registration-password", ...input });
    assert.equal(result.status, status);
    assert.equal(result.response.headers["set-cookie"], undefined);
    assert.equal(await f.app.context.db.get("SELECT id FROM users WHERE username=?", [username]), undefined);
  }
  const result = await f.request("POST", "/api/auth/register", { username: "invited-member", password: "registration-password", inviteToken: invite.token, invitePassword: "share-password" });
  assert.equal(result.status, 200);
  assert.equal(result.body.roomId, room.id);
  const member = { ...result.body, cookie: result.response.headers["set-cookie"].split(";")[0] };
  assert.equal((await f.request("GET", `/api/rooms/${room.id}`, undefined, member)).body.role, "viewer");
  assert.equal((await f.send(room.id, member, [{ type: "create", node: textNode() }])).status, 403);
  assert.equal((await f.request("DELETE", `/api/rooms/${room.id}/shares/${invite.id}`, undefined, owner)).status, 200);
  assert.equal((await f.request("GET", `/api/rooms/${room.id}`, undefined, member)).status, 404);
});

test("registration retains origin checks, strict input validation and source rate limits", async (t) => {
  const f = await fixture(t);
  const credentials = { username: "new-member", password: "registration-password" };
  assert.equal((await f.request("POST", "/api/auth/register", credentials, undefined, { origin: "https://attacker.example" })).status, 403);
  assert.equal((await f.request("POST", "/api/auth/register", { ...credentials, admin: true })).status, 400);
  assert.equal((await f.request("POST", "/api/auth/register", { ...credentials, password: "short" })).status, 400);
  const source = { "x-forwarded-for": "203.0.113.7" };
  for (let index = 0; index < f.config.AUTH_ATTEMPTS_PER_MINUTE; index++) {
    assert.equal((await f.request("POST", "/api/auth/register", {}, undefined, source)).status, 400);
  }
  assert.equal((await f.request("POST", "/api/auth/register", credentials, undefined, source)).status, 429);
  assert.equal(await f.app.context.db.get("SELECT id FROM users WHERE username=?", [credentials.username]), undefined);
});
