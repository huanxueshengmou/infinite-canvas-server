import test from "node:test";
import assert from "node:assert/strict";
import { fixture, privateNode } from "./helpers.js";
import { resolveTarget } from "../src/egress.js";

test("admin provider modes preserve independent lists and apply immediately to requests", async (t) => {
  let runtime;
  const f = await fixture(t, { API_ALLOWED_HOSTS: "environment.example.com" }, { executeRequest: async (_request, config) => { runtime = config; return { status: 200, text: "ok" }; } });
  const admin = await f.login(await f.user("admin", true)), member = await f.login(await f.user("member"));
  const get = async () => (await f.request("GET", "/api/admin/providers", undefined, admin)).body;
  assert.deepEqual(await get(), { whitelistEnabled: true, whitelist: ["environment.example.com"], blacklist: [] });
  await f.app.context.db.run("INSERT INTO settings(key,value) VALUES('api_hosts',?)", ['["previous.example.com"]']);
  assert.deepEqual((await get()).whitelist, ["previous.example.com"]);
  const policy = { whitelistEnabled: false, whitelist: ["Allowed.Example.COM.", "allowed.example.com"], blacklist: ["blocked.example.com"] };
  assert.equal((await f.request("PUT", "/api/admin/providers", policy, member)).status, 403);
  assert.equal((await f.request("PUT", "/api/admin/providers", policy, admin, { "x-csrf-token": "wrong" })).status, 403);
  assert.equal((await f.request("PUT", "/api/admin/providers", policy, admin)).status, 200);
  const normalized = { ...policy, whitelist: ["allowed.example.com"] };
  assert.deepEqual(await get(), normalized);
  const room = await f.room(member), node = privateNode();
  await f.send(room.id, member, [{ type: "create", node }]);
  assert.equal((await f.request("POST", `/api/rooms/${room.id}/private/${node.id}/run`, { version: 1 }, member)).status, 200);
  assert.deepEqual(runtime.providerPolicy, normalized);
  for (const whitelistEnabled of [true, false]) {
    const next = { ...normalized, whitelistEnabled };
    assert.equal((await f.request("PUT", "/api/admin/providers", next, admin)).status, 200);
    assert.deepEqual(await get(), next);
  }
  assert.equal((await f.request("PUT", "/api/admin/providers", { ...normalized, blacklist: ["https://invalid.example.com/path"] }, admin)).status, 400);
  assert.deepEqual(await get(), normalized);
  assert.equal((await f.app.context.db.all("SELECT * FROM audit WHERE action='providers.update'")).length, 3);
});

test("white and black lists are independent, canonicalize hostnames and never bypass public-address checks", async () => {
  const dns = async () => [{ address: "8.8.8.8", family: 4 }];
  const policy = { whitelistEnabled: true, whitelist: ["api.example.com"], blacklist: ["api.example.com", "blocked.example.com"] };
  assert.equal((await resolveTarget("https://API.EXAMPLE.COM./v1", policy, dns)).address.address, "8.8.8.8");
  await assert.rejects(resolveTarget("https://unlisted.example.com", policy, dns), /白名单/);
  const open = { ...policy, whitelistEnabled: false };
  assert.equal((await resolveTarget("https://unlisted.example.com", open, dns)).address.address, "8.8.8.8");
  for (const hostname of ["api.example.com", "blocked.example.com", "sub.blocked.example.com", "BLOCKED.EXAMPLE.COM."]) await assert.rejects(resolveTarget(`https://${hostname}`, open, dns), /黑名单/);
  assert.equal((await resolveTarget("https://blocked.example.com.attacker.test", open, dns)).address.address, "8.8.8.8");
  for (const enabled of [true, false]) {
    const current = { ...policy, whitelistEnabled: enabled, blacklist: [] };
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.2", "::ffff:127.0.0.1", "100.100.100.200"]) await assert.rejects(resolveTarget("https://api.example.com", current, async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]), /内网/);
    for (const url of ["http://api.example.com", "https://api.example.com:8443", "https://user:pass@api.example.com", "https://api.example.com/#fragment"]) await assert.rejects(resolveTarget(url, current, dns), /HTTPS/);
  }
});
