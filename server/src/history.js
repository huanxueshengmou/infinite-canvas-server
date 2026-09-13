import { decrypt, encrypt, digest } from "./crypto.js";
import { publicNode, publicEdge } from "./schemas.js";
import { assertEdgeOwner, validateGraph } from "./graph.js";
import { validateBoardLayout } from "./board-layout.js";
import { HttpError, auditStep } from "./rooms.js";

const context = (roomId, userId, id) => `history:${roomId}:${userId}:${id}`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = () => { throw new HttpError(409, "相关节点、隐私内容或连线已变化，撤销 / 重做未覆盖当前内容"); };
const fields = ["id", "room_id", "owner_id", "visibility", "version", "public_json", "private_cipher", "private_version", "result_cipher"];

export async function historyStep(rooms, roomId, userId, id, before, after) {
  const existing = await rooms.db.get("SELECT cipher FROM operation_history WHERE room_id=? AND user_id=? AND id=?", [roomId, userId, id]);
  const value = existing ? decrypt(rooms.key, existing.cipher, context(roomId, userId, id)) : { before: { nodes: {}, edges: {} }, after: { nodes: {}, edges: {} }, clocks: { nodes: {}, edges: {} }, phase: "applied" };
  if (value.phase !== "applied") fail();
  for (const kind of ["nodes", "edges"]) for (const key of Object.keys(after[kind])) {
    if (!Object.hasOwn(value.before[kind], key)) value.before[kind][key] = before[kind][key];
    value.after[kind][key] = after[kind][key];
    const previous = value.clocks[kind][key] || {};
    value.clocks[kind][key] = {
      version: Math.max(previous.version || 0, before[kind][key]?.version || 0, after[kind][key]?.version || 0),
      privateVersion: Math.max(previous.privateVersion || 0, before[kind][key]?.private_version || 0, after[kind][key]?.private_version || 0),
    };
  }
  return { sql: "INSERT INTO operation_history(room_id,user_id,id,cipher) VALUES(?,?,?,?) ON CONFLICT(room_id,user_id,id) DO UPDATE SET cipher=excluded.cipher", params: [roomId, userId, id, encrypt(rooms.key, value, context(roomId, userId, id))] };
}

export async function applyHistory(rooms, roomId, userId, historyId, action, guard) {
  return rooms.lock(roomId, async () => {
    const access = await rooms.access(roomId, userId);
    rooms.assertEditor(access);
    await guard();
    const hash = digest(JSON.stringify({ historyId, ...action }));
    const receipt = await rooms.db.get("SELECT * FROM receipts WHERE room_id=? AND user_id=? AND operation_id=?", [roomId, userId, action.operationId]);
    if (receipt) { if (receipt.request_hash !== hash) fail(); return JSON.parse(receipt.result_json); }
    const stored = await rooms.db.get("SELECT cipher FROM operation_history WHERE room_id=? AND user_id=? AND id=?", [roomId, userId, historyId]);
    if (!stored) throw new HttpError(404, "没有当前账户的这条操作历史");
    const history = decrypt(rooms.key, stored.cipher, context(roomId, userId, historyId));
    const undo = action.direction === "undo";
    if (history.phase !== (undo ? "applied" : "undone")) fail();
    const from = undo ? history.after : history.before, target = undo ? history.before : history.after;
    const nodes = new Map((await rooms.db.all("SELECT * FROM nodes WHERE room_id=?", [roomId])).map((row) => [row.id, row]));
    const edges = new Map((await rooms.db.all("SELECT * FROM edges WHERE room_id=?", [roomId])).map((row) => [row.id, row]));
    const originalNodes = new Map(nodes), originalEdges = new Map(edges), changes = [];
    for (const [kind, current] of [["nodes", nodes], ["edges", edges]]) {
      if (!equal(Object.keys(action[kind]).sort(), Object.keys(from[kind]).sort())) fail();
      for (const id of Object.keys(from[kind])) if ((current.get(id)?.version ?? null) !== action[kind][id]) fail();
    }
    for (const [id, previous] of Object.entries(from.nodes)) {
      const current = nodes.get(id), next = target.nodes[id];
      if (Boolean(current) !== Boolean(previous)) fail();
      if (current && (current.owner_id !== previous.owner_id || current.visibility !== previous.visibility)) fail();
      const clock = history.clocks.nodes[id];
      clock.version = Math.max(clock.version, current?.version || 0);
      clock.privateVersion = Math.max(clock.privateVersion, current?.private_version || 0);
      if (!next) {
        if (current && (!equal(JSON.parse(current.public_json), JSON.parse(previous.public_json)) || (current.visibility === "private" && (current.private_cipher !== previous.private_cipher || current.result_cipher !== previous.result_cipher)))) fail();
        nodes.delete(id);
        if (current) changes.push({ type: "delete", id });
      } else {
        let row;
        if (current) {
          const old = JSON.parse(previous.public_json), desired = JSON.parse(next.public_json), value = JSON.parse(current.public_json);
          for (const field of new Set([...Object.keys(old), ...Object.keys(desired)])) if (!equal(old[field], desired[field])) {
            if (!equal(value[field], old[field])) fail();
            if (desired[field] === undefined) delete value[field]; else value[field] = desired[field];
          }
          // Moving a private placeholder never rolls back its separate API configuration or result.
          row = { ...current, version: ++clock.version, public_json: JSON.stringify(value) };
        } else {
          row = { ...next, version: ++clock.version, private_version: ++clock.privateVersion };
          if (row.visibility === "private" && row.result_cipher) {
            const resultContext = `${roomId}:${id}:${row.owner_id}:result`;
            const result = decrypt(rooms.key, row.result_cipher, resultContext);
            if (result.configVersion === next.private_version) result.configVersion = row.private_version;
            row.result_cipher = encrypt(rooms.key, result, resultContext);
          }
        }
        await rooms.checkFile(roomId, JSON.parse(row.public_json).fileId);
        nodes.set(id, row); target.nodes[id] = row;
        changes.push({ type: "upsert", node: publicNode(row) });
      }
    }
    for (const [id, previous] of Object.entries(from.edges)) {
      const current = edges.get(id), next = target.edges[id];
      if (Boolean(current) !== Boolean(previous)) fail();
      if (current && ["source", "source_port", "target", "target_port"].some((field) => current[field] !== previous[field])) fail();
      const clock = history.clocks.edges[id];
      clock.version = Math.max(clock.version, current?.version || 0);
      if (next) {
        const row = { ...next, version: ++clock.version };
        assertEdgeOwner(row, nodes, userId);
        edges.set(id, row); target.edges[id] = row;
        changes.push({ type: "edge-upsert", edge: publicEdge(row) });
      } else { edges.delete(id); if (current) changes.push({ type: "edge-delete", id }); }
    }
    // New connections made by a collaborator cannot be silently deleted by undoing a node creation.
    if ([...edges.values()].some((edge) => !nodes.has(edge.source) || !nodes.has(edge.target))) fail();
    validateGraph(edges, nodes);
    try { validateBoardLayout(nodes); } catch { fail(); }
    const steps = [];
    for (const id of Object.keys(from.edges)) if (originalEdges.has(id)) steps.push({ sql: "DELETE FROM edges WHERE room_id=? AND id=? AND version=?", params: [roomId, id, originalEdges.get(id).version], expectChanges: 1 });
    for (const id of Object.keys(from.nodes)) {
      const current = originalNodes.get(id), next = nodes.get(id);
      if (current && !next) steps.push({ sql: "DELETE FROM nodes WHERE room_id=? AND id=? AND version=? AND private_version=?", params: [roomId, id, current.version, current.private_version], expectChanges: 1 });
      else if (current && next) steps.push({ sql: "UPDATE nodes SET version=?,public_json=?,private_cipher=?,private_version=?,result_cipher=? WHERE room_id=? AND id=? AND version=? AND private_version=?", params: [next.version, next.public_json, next.private_cipher, next.private_version, next.result_cipher, roomId, id, current.version, current.private_version], expectChanges: 1 });
      else if (next) steps.push({ sql: `INSERT INTO nodes(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`, params: fields.map((field) => next[field]) });
    }
    for (const id of Object.keys(from.edges)) if (edges.has(id)) {
      const row = edges.get(id);
      steps.push({ sql: "INSERT INTO edges(id,room_id,source,source_port,target,target_port,version) VALUES(?,?,?,?,?,?,?)", params: [row.id, roomId, row.source, row.source_port, row.target, row.target_port, row.version] });
    }
    history.phase = undo ? "undone" : "applied";
    const event = { type: "changes", operationId: action.operationId, revision: access.revision + 1, changes };
    const result = { event, ownPrivateIds: [...nodes.values()].filter((node) => node.visibility === "private" && node.owner_id === userId).map((node) => node.id) };
    steps.push(
      { sql: "UPDATE operation_history SET cipher=? WHERE room_id=? AND user_id=? AND id=? AND cipher=?", params: [encrypt(rooms.key, history, context(roomId, userId, historyId)), roomId, userId, historyId, stored.cipher], expectChanges: 1 },
      { sql: "UPDATE rooms SET revision=revision+1 WHERE id=? AND revision=?", params: [roomId, access.revision], expectChanges: 1 },
      { sql: "INSERT INTO receipts(room_id,user_id,operation_id,request_hash,result_json) VALUES(?,?,?,?,?)", params: [roomId, userId, action.operationId, hash, JSON.stringify(result)] },
      auditStep(userId, roomId, `nodes.${action.direction}`, historyId),
    );
    await guard();
    await rooms.db.transaction(steps);
    for (const request of rooms.runningRequests) if (request.roomId === roomId && Object.hasOwn(from.nodes, request.nodeId) && !nodes.has(request.nodeId)) request.controller.abort();
    rooms.broadcast(roomId, event);
    return result;
  });
}
