import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { digest, encrypt } from "./crypto.js";
import { publicNode, publicEdge, cursorSchema, PROTOCOL_VERSION } from "./schemas.js";
import { assertEdgeOwner, validateGraph } from "./graph.js";
import { historyStep } from "./history.js";
import { validateBoardLayout, validateBoardNode } from "./board-layout.js";

export class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const auditStep = (userId, roomId, action, targetId = null) => ({
  sql: "INSERT INTO audit(user_id,room_id,action,target_id,created_at) VALUES(?,?,?,?,?)",
  params: [userId, roomId, action, targetId, Date.now()],
});

export class Rooms {
  constructor(db, key, config) {
    this.db = db;
    this.key = key;
    this.config = config;
    this.queues = new Map();
    this.clients = new Map();
    this.runningRequests = new Set();
    this.cursorRooms = new Set();
    this.cursorSequence = 0;
    this.cursorTimer = setInterval(() => {
      for (const roomId of this.cursorRooms) {
        const cursors = new Map();
        for (const socket of this.clients.get(roomId) || []) {
          if (socket.cursor && socket.readyState === WebSocket.OPEN && (!cursors.has(socket.userId) || cursors.get(socket.userId).sequence < socket.cursor.sequence)) cursors.set(socket.userId, socket.cursor);
        }
        this.broadcast(roomId, { type: "cursors", cursors: [...cursors.values()].map(({ sequence, ...cursor }) => cursor) });
      }
      this.cursorRooms.clear();
    }, config.SYNC_BATCH_MS);
    this.cursorTimer.unref();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.MAX_SYNC_BYTES, perMessageDeflate: false });
    this.heartbeat = setInterval(() => {
      for (const clients of this.clients.values()) for (const socket of clients) {
        if (!socket.alive) { socket.terminate(); continue; }
        socket.alive = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, config.API_TIMEOUT_MS / 2);
    this.heartbeat.unref();
  }

  async lock(id, task) {
    const previous = this.queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.queues.set(id, current);
    try { return await current; }
    finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }

  async access(roomId, userId) {
    const row = await this.db.get(`SELECT r.*, m.role AS member_role, m.share_id, s.expires_at, s.revoked
      FROM rooms r LEFT JOIN members m ON m.room_id=r.id AND m.user_id=?
      LEFT JOIN shares s ON s.id=m.share_id WHERE r.id=?`, [userId, roomId]);
    if (!row) throw new HttpError(404, "画布不存在或没有访问权限");
    if (row.owner_id === userId) return { ...row, role: "owner", accessUntil: Infinity };
    if (!row.member_role || (row.share_id && (row.revoked || row.expires_at <= Date.now()))) throw new HttpError(404, "画布不存在或授权已失效");
    return { ...row, role: row.member_role, accessUntil: row.share_id ? row.expires_at : Infinity };
  }

  assertEditor(access) {
    if (access.role === "viewer") throw new HttpError(403, "当前为只读权限");
  }

  assertOwner(access) {
    if (access.role !== "owner") throw new HttpError(403, "只有画布所有者可以管理分享和成员");
  }

  async privateNode(roomId, nodeId, userId, edit = false) {
    const access = await this.access(roomId, userId);
    if (edit) this.assertEditor(access);
    const row = await this.db.get("SELECT * FROM nodes WHERE room_id=? AND id=?", [roomId, nodeId]);
    if (!row || row.visibility !== "private" || row.owner_id !== userId) throw new HttpError(404, "隐私节点不存在或不属于当前账户");
    return row;
  }

  async checkFile(roomId, fileId, kind) {
    if (!fileId) return;
    const file = await this.db.get("SELECT mime FROM files WHERE id=? AND room_id=?", [fileId, roomId]);
    if (!file) throw new HttpError(400, "文件不属于当前画布");
    if ((kind === "image" && !file.mime.startsWith("image/")) || (kind === "video" && !file.mime.startsWith("video/"))) throw new HttpError(400, "此文件不支持该媒体预览，请使用文件附件节点");
  }

  async apply(roomId, userId, mutation, guard) {
    return this.lock(roomId, async () => {
      const access = await this.access(roomId, userId);
      this.assertEditor(access);
      if (guard) await guard();
      const requestHash = digest(JSON.stringify(mutation));
      const receipt = await this.db.get("SELECT * FROM receipts WHERE room_id=? AND user_id=? AND operation_id=?", [roomId, userId, mutation.operationId]);
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new HttpError(409, "操作标识已用于其他请求");
        return JSON.parse(receipt.result_json);
      }
      const changes = [];
      const steps = [];
      const before = { nodes: {}, edges: {} }, after = { nodes: {}, edges: {} };
      const seen = new Set();
      const graphChanged = mutation.operations.some((operation) => ["connect", "disconnect", "delete"].includes(operation.type));
      const layoutChanged = mutation.operations.some((operation) => operation.type === "delete" || (operation.type === "create" && (operation.node.kind === "group" || operation.node.groupId)) || (operation.type === "update" && Object.hasOwn(operation.fields, "groupId")));
      const nodes = graphChanged || layoutChanged ? new Map((await this.db.all("SELECT id,room_id,owner_id,visibility,version,public_json FROM nodes WHERE room_id=?", [roomId])).map((row) => [row.id, row])) : null;
      const edges = graphChanged ? new Map((await this.db.all("SELECT * FROM edges WHERE room_id=?", [roomId])).map((row) => [row.id, row])) : null;
      const originalEdges = edges ? new Map(edges) : null;
      const originalNodes = nodes ? new Map(nodes) : null;
      for (const operation of mutation.operations.filter((operation) => !["connect", "disconnect"].includes(operation.type))) {
        const id = operation.type === "create" ? operation.node.id : operation.id;
        if (seen.has(id)) throw new HttpError(400, "一批操作中不能重复修改同一节点");
        seen.add(id);
        const existing = await this.db.get("SELECT * FROM nodes WHERE room_id=? AND id=?", [roomId, id]);
        before.nodes[id] = existing || null;
        if (operation.type === "create") {
          if (existing) throw new HttpError(409, "节点已存在");
          const source = operation.node;
          const isPrivate = source.kind === "private";
          if (isPrivate !== Boolean(source.privateData)) throw new HttpError(400, "隐私数据必须使用隐私节点");
          if (source.outputType && source.kind !== "custom") throw new HttpError(400, "输出格式只适用于自定义节点");
          if (isPrivate && (source.groupId || source.drawing)) throw new HttpError(400, "隐私节点不保存公开分组或笔迹");
          await this.checkFile(roomId, isPrivate ? null : source.fileId, source.kind);
          const value = { kind: source.kind, position: source.position, width: source.width, height: source.height,
            title: isPrivate ? "隐私节点" : source.title, content: isPrivate ? "" : source.content, fileId: isPrivate ? null : source.fileId,
            ...(source.kind === "custom" ? { outputType: source.outputType || "text" } : {}),
            ...(Object.hasOwn(source, "groupId") ? { groupId: source.groupId } : {}),
            ...(source.drawing ? { drawing: source.drawing } : source.kind === "whiteboard" ? { drawing: [] } : {}) };
          validateBoardNode(value);
          const row = { id, room_id: roomId, owner_id: userId, visibility: isPrivate ? "private" : "public", version: 1, public_json: JSON.stringify(value) };
          const cipher = isPrivate ? encrypt(this.key, source.privateData, `${roomId}:${id}:${userId}`) : null;
          after.nodes[id] = { ...row, private_cipher: cipher, private_version: 1, result_cipher: null };
          steps.push({ sql: "INSERT INTO nodes(id,room_id,owner_id,visibility,version,public_json,private_cipher) VALUES(?,?,?,?,?,?,?)",
            params: [id, roomId, userId, row.visibility, 1, row.public_json, cipher] });
          changes.push({ type: "upsert", node: publicNode(row) });
          nodes?.set(id, row);
        } else {
          if (!existing) throw new HttpError(409, "节点已被删除", { nodeId: id, deleted: true });
          if (existing.visibility === "private" && existing.owner_id !== userId) throw new HttpError(403, "不能修改他人的隐私节点");
          if (existing.version !== operation.version) throw new HttpError(409, "节点已被其他人修改，草稿已保留", { node: publicNode(existing) });
          if (operation.type === "delete") {
            after.nodes[id] = null;
            steps.push({ sql: "DELETE FROM nodes WHERE room_id=? AND id=? AND version=?", params: [roomId, id, operation.version], expectChanges: 1 });
            changes.push({ type: "delete", id });
            nodes?.delete(id);
          } else {
            if (existing.visibility === "private" && Object.keys(operation.fields).some((key) => !["position", "width", "height"].includes(key))) throw new HttpError(400, "隐私内容只能经专用接口保存");
            await this.checkFile(roomId, operation.fields.fileId, JSON.parse(existing.public_json).kind);
            if (operation.fields.outputType && JSON.parse(existing.public_json).kind !== "custom") throw new HttpError(400, "输出格式只适用于自定义节点");
            const value = { ...JSON.parse(existing.public_json), ...operation.fields };
            validateBoardNode(value);
            const row = { ...existing, version: existing.version + 1, public_json: JSON.stringify(value) };
            after.nodes[id] = row;
            steps.push({ sql: "UPDATE nodes SET public_json=?,version=? WHERE room_id=? AND id=? AND version=?",
              params: [row.public_json, row.version, roomId, id, operation.version], expectChanges: 1 });
            changes.push({ type: "upsert", node: publicNode(row) });
            nodes?.set(id, row);
          }
        }
      }
      if (graphChanged) {
        const seenEdges = new Set();
        for (const operation of mutation.operations.filter((operation) => ["connect", "disconnect"].includes(operation.type))) {
          const id = operation.type === "connect" ? operation.edge.id : operation.id;
          if (seenEdges.has(id)) throw new HttpError(400, "一批操作中不能重复修改同一连线");
          seenEdges.add(id);
          const existing = originalEdges.get(id);
          if (existing) {
            assertEdgeOwner(existing, originalNodes, userId);
            if (operation.version !== existing.version) throw new HttpError(409, "连线已改变，请刷新后重试");
          } else if (operation.version || operation.type === "disconnect") throw new HttpError(409, "连线已被删除或不存在");
          if (operation.type === "disconnect") edges.delete(id);
          else {
            const edge = { id, room_id: roomId, source: operation.edge.source, source_port: operation.edge.sourcePort,
              target: operation.edge.target, target_port: operation.edge.targetPort, version: (existing?.version || 0) + 1 };
            assertEdgeOwner(edge, nodes, userId);
            if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new HttpError(400, "连线节点不属于当前画布或已被删除");
            if (edge.target_port === "audio" && nodes.get(edge.source).visibility !== "private") {
              const fileId = JSON.parse(nodes.get(edge.source).public_json).fileId;
              const file = fileId && await this.db.get("SELECT mime FROM files WHERE room_id=? AND id=?", [roomId, fileId]);
              if (!file?.mime.startsWith("audio/")) throw new HttpError(400, "音频输入必须连接音频文件");
            }
            edges.set(id, edge);
          }
        }
        for (const [id, edge] of edges) if (!nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(id);
        validateGraph(edges, nodes);
        const deletes = [], inserts = [];
        for (const [id, old] of originalEdges) {
          const current = edges.get(id);
          if (!current || current.version !== old.version) {
            before.edges[id] = old; after.edges[id] = current || null;
            deletes.push({ sql: "DELETE FROM edges WHERE room_id=? AND id=? AND version=?", params: [roomId, id, old.version], expectChanges: 1 });
            if (!current) changes.push({ type: "edge-delete", id });
          }
        }
        for (const [id, edge] of edges) if (originalEdges.get(id)?.version !== edge.version) {
          before.edges[id] = originalEdges.get(id) || null; after.edges[id] = edge;
          inserts.push({ sql: "INSERT INTO edges(id,room_id,source,source_port,target,target_port,version) VALUES(?,?,?,?,?,?,?)",
            params: [id, roomId, edge.source, edge.source_port, edge.target, edge.target_port, edge.version] });
          changes.push({ type: "edge-upsert", edge: publicEdge(edge) });
        }
        steps.unshift(...deletes);
        steps.push(...inserts);
      }
      if (layoutChanged) validateBoardLayout(nodes);
      const historyId = mutation.historyId || mutation.operationId;
      const result = { type: "changes", operationId: mutation.operationId, historyId, revision: access.revision + 1, changes };
      steps.push(
        await historyStep(this, roomId, userId, historyId, before, after),
        { sql: "UPDATE rooms SET revision=revision+1 WHERE id=? AND revision=?", params: [roomId, access.revision], expectChanges: 1 },
        { sql: "INSERT INTO receipts(room_id,user_id,operation_id,request_hash,result_json) VALUES(?,?,?,?,?)", params: [roomId, userId, mutation.operationId, requestHash, JSON.stringify(result)] },
        auditStep(userId, roomId, "nodes.update", mutation.operationId),
      );
      await this.db.transaction(steps);
      // The acknowledgement and broadcast happen only after the durable transaction commits.
      this.broadcast(roomId, result);
      return result;
    });
  }

  send(socket, value) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > this.config.MAX_SYNC_BYTES) { socket.close(1013, "慢连接，请重新同步"); return; }
    socket.send(JSON.stringify(value));
  }

  broadcast(roomId, value) {
    for (const socket of this.clients.get(roomId) || []) this.send(socket, value);
  }

  presence(roomId) {
    const sockets = this.clients.get(roomId) || [];
    this.broadcast(roomId, { type: "presence", count: new Set([...sockets].map((socket) => socket.userId)).size });
  }

  async connect(request, socket, head, session, roomId, protocolVersion) {
    return this.lock(roomId, async () => {
      const access = await this.access(roomId, session.user.id);
      const clients = this.clients.get(roomId) || new Set();
      if (clients.size >= this.config.MAX_ROOM_CONNECTIONS) throw new HttpError(429, "当前画布在线连接已达上限");
      const rows = await this.db.all("SELECT id,owner_id,visibility,version,public_json FROM nodes WHERE room_id=?", [roomId]);
      const edges = await this.db.all("SELECT * FROM edges WHERE room_id=?", [roomId]);
      const ws = await new Promise((resolve) => this.wss.handleUpgrade(request, socket, head, resolve));
      ws.userId = session.user.id;
      ws.username = session.user.username;
      ws.sessionHash = session.hash;
      ws.roomId = roomId;
      ws.alive = true;
      ws.on("pong", () => { ws.alive = true; });
      clients.add(ws);
      this.clients.set(roomId, clients);
      const expiresAt = Math.min(session.expiresAt, access.accessUntil);
      ws.expiry = setTimeout(() => ws.close(4001, "授权已过期"), Math.max(1, expiresAt - Date.now()));
      ws.expiry.unref();
      ws.on("error", () => {});
      ws.on("message", (data, binary) => {
        try {
          if (binary) throw new Error("Binary cursor message");
          const cursor = cursorSchema.parse(JSON.parse(data.toString()));
          ws.cursor = cursor.position ? { userId: ws.userId, username: ws.username, position: cursor.position, sequence: ++this.cursorSequence } : null;
          this.cursorRooms.add(roomId);
        } catch { ws.close(1008, "无效的鼠标消息，内容修改请使用鉴权接口"); }
      });
      ws.on("close", () => {
        clearTimeout(ws.expiry);
        clients.delete(ws);
        if (!clients.size) this.clients.delete(roomId);
        this.cursorRooms.add(roomId);
        this.presence(roomId);
      });
      if (protocolVersion !== PROTOCOL_VERSION) { ws.close(4001, "协作服务已更新，请刷新网页"); return; }
      // Stream the initial snapshot, allowing arbitrarily sized rooms without one giant frame.
      const send = (value) => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Socket closed during snapshot"));
        ws.send(JSON.stringify(value), (error) => error ? reject(error) : resolve());
      });
      await send({ type: "snapshot-start", userId: session.user.id, room: { id: roomId, title: access.title, revision: access.revision, role: access.role } });
      for (const row of rows) await send({ type: "snapshot-node", node: publicNode(row), ownPrivate: row.visibility === "private" && row.owner_id === session.user.id });
      for (const row of edges) await send({ type: "snapshot-edge", edge: publicEdge(row) });
      await send({ type: "snapshot-end", revision: access.revision });
      this.presence(roomId);
      this.cursorRooms.add(roomId);
    });
  }

  disconnect(roomId, userId) {
    for (const socket of this.clients.get(roomId) || []) {
      if (!userId || socket.userId === userId) socket.close(4001, "权限已变更，请重新验证");
    }
    for (const request of this.runningRequests) {
      if (request.roomId === roomId && (!userId || request.userId === userId)) request.controller.abort();
    }
  }

  logout(sessionHash) {
    for (const clients of this.clients.values()) {
      for (const socket of clients) if (socket.sessionHash === sessionHash) socket.close(4001, "已退出登录");
    }
    for (const request of this.runningRequests) if (request.sessionHash === sessionHash) request.controller.abort();
  }

  async close() {
    clearInterval(this.heartbeat);
    clearInterval(this.cursorTimer);
    for (const clients of this.clients.values()) for (const socket of clients) socket.terminate();
    for (const request of this.runningRequests) request.controller.abort();
    await Promise.allSettled([...this.queues.values()]);
    await new Promise((resolve) => this.wss.close(resolve));
  }
}
