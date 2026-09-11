import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { encrypt, decrypt, digest } from "./crypto.js";
import { idSchema, privateSchema, templateSchema } from "./schemas.js";
import { HttpError, auditStep } from "./rooms.js";
import { checkStorage, saveEncryptedFile } from "./storage.js";
import { executePrivateRequest, openResultMedia } from "./egress.js";
import { atPath, parseResult, resultMedia, selectedMedia, graphContext, evaluateCustom, renderJson, renderText, requestBody } from "./workflow.js";
import { builtInTemplates } from "./node-templates.js";

export function privateRecord(row, key, context) {
  const data = privateSchema.parse(decrypt(key, row.private_cipher, context));
  const result = row.result_cipher ? decrypt(key, row.result_cipher, `${context}:result`) : null;
  if (result && !result.id) result.id = digest(row.result_cipher);
  return { data, version: row.private_version, result, media: result ? resultMedia(result, data.category) : [] };
}

export function registerWorkflowRoutes(app, { runIO, writeRate, sessionFromCookie, uploadLimit, executeRequest, openMedia }) {
  const { rooms, db, key, config } = app.context;
  const templateValue = (request) => {
    const value = templateSchema.parse(request.body);
    // Deliberately do not copy provider credentials into a reusable template.
    if (value.privateData) value.privateData.request.apiKey = "";
    return value;
  };
  app.get("/api/node-templates", async (request) => {
    const userId = request.session.user.id;
    const rows = await db.all("SELECT * FROM node_templates WHERE owner_id=? ORDER BY created_at DESC", [userId]);
    return [...builtInTemplates, ...rows.map((row) => ({ id: row.id, version: row.version, builtIn: false, ...decrypt(key, row.cipher, `template:${userId}:${row.id}`) }))];
  });
  app.post("/api/node-templates", { config: writeRate }, async (request) => {
    await checkStorage(config);
    const value = templateValue(request), id = randomUUID(), userId = request.session.user.id;
    await db.transaction([
      { sql: "INSERT INTO node_templates(id,owner_id,cipher,version,created_at) VALUES(?,?,?,?,?)", params: [id, userId, encrypt(key, value, `template:${userId}:${id}`), 1, Date.now()] },
      auditStep(userId, null, "template.create", id),
    ]);
    return { ...value, id, version: 1, builtIn: false };
  });
  app.put("/api/node-templates/:templateId", { config: writeRate }, async (request) => {
    const id = idSchema.parse(request.params.templateId), userId = request.session.user.id;
    const { version, template } = z.object({ version: z.number().int().positive(), template: templateSchema }).strict().parse(request.body);
    if (template.privateData) template.privateData.request.apiKey = "";
    await checkStorage(config);
    const row = await db.get("SELECT version FROM node_templates WHERE id=? AND owner_id=?", [id, userId]);
    if (!row) throw new HttpError(404, "模板不存在或不属于当前账户");
    if (row.version !== version) throw new HttpError(409, "模板已在其他窗口修改");
    await db.transaction([
      { sql: "UPDATE node_templates SET cipher=?,version=version+1 WHERE id=? AND owner_id=? AND version=?", params: [encrypt(key, template, `template:${userId}:${id}`), id, userId, version], expectChanges: 1 },
      auditStep(userId, null, "template.update", id),
    ]);
    return { ...template, id, version: version + 1, builtIn: false };
  });
  app.delete("/api/node-templates/:templateId", { config: writeRate }, async (request) => {
    const id = idSchema.parse(request.params.templateId), userId = request.session.user.id;
    const row = await db.get("SELECT id FROM node_templates WHERE id=? AND owner_id=?", [id, userId]);
    if (!row) throw new HttpError(404, "模板不存在或不属于当前账户");
    await db.transaction([
      { sql: "DELETE FROM node_templates WHERE id=? AND owner_id=?", params: [id, userId], expectChanges: 1 },
      auditStep(userId, null, "template.delete", id),
    ]);
    return { ok: true };
  });

  app.post("/api/rooms/:roomId/nodes/:nodeId/evaluate", { config: writeRate }, async (request) => {
    const roomId = idSchema.parse(request.params.roomId), id = idSchema.parse(request.params.nodeId), userId = request.session.user.id;
    await rooms.access(roomId, userId);
    const target = await db.get("SELECT * FROM nodes WHERE room_id=? AND id=?", [roomId, id]);
    if (!target || target.visibility !== "public" || JSON.parse(target.public_json).kind !== "custom") throw new HttpError(404, "自定义节点不存在");
    const graph = await graphContext(rooms, roomId, id, userId);
    const output = evaluateCustom(JSON.parse(graph.node.public_json), graph.context, config);
    await sessionFromCookie(request.headers.cookie);
    await rooms.access(roomId, userId);
    return { ...output, revision: graph.revision };
  });

  const privateIO = (request, reply, task) => runIO(async () => {
    const roomId = idSchema.parse(request.params.roomId), nodeId = idSchema.parse(request.params.nodeId), userId = request.session.user.id;
    const edit = request.method !== "GET";
    const row = await rooms.privateNode(roomId, nodeId, userId, edit);
    await sessionFromCookie(request.headers.cookie);
    const access = await rooms.access(roomId, userId);
    if (edit && [...rooms.runningRequests].some((active) => active.nodeId === nodeId && active.roomId === roomId && active.edit)) throw new HttpError(409, "这个隐私节点正在处理请求，请等待完成后再操作");
    const controller = new AbortController(), context = `${roomId}:${nodeId}:${userId}`;
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", abort);
    const active = { controller, roomId, userId, nodeId, edit, sessionHash: request.session.hash };
    rooms.runningRequests.add(active);
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(config.API_TIMEOUT_MS, request.session.expiresAt - Date.now(), access.accessUntil - Date.now())));
    timer.unref();
    const recheck = async () => {
      if (controller.signal.aborted) throw new HttpError(401, "请求已取消、超时或授权已失效");
      await sessionFromCookie(request.headers.cookie);
      const current = await rooms.privateNode(roomId, nodeId, userId, edit);
      if (current.private_version !== row.private_version) throw new HttpError(409, "请求期间配置已改变，本次结果未覆盖已保存内容");
      return current;
    };
    try {
      const setting = await db.get("SELECT value FROM settings WHERE key='api_hosts'");
      const runtime = { ...config, allowedHosts: setting ? JSON.parse(setting.value) : config.allowedHosts, MAX_FILE_BYTES: await uploadLimit() };
      return await task({ row, context, record: privateRecord(row, key, context), runtime, signal: controller.signal, recheck });
    } finally { clearTimeout(timer); rooms.runningRequests.delete(active); reply.raw.off("close", abort); }
  });

  app.post("/api/rooms/:roomId/private/:nodeId/run", { config: writeRate }, async (request, reply) => privateIO(request, reply, async ({ row, context, record, runtime, signal, recheck }) => {
    const { version, action } = z.object({ version: z.number().int().positive(), action: z.enum(["run", "poll"]).default("run") }).strict().parse(request.body);
    if (version !== row.private_version) throw new HttpError(409, "请先保存并刷新隐私配置");
    await checkStorage(config);
    const params = Object.fromEntries(record.data.fields.map((field) => {
      const value = field.type === "number" ? Number(field.value) : field.type === "boolean" ? field.value === true || field.value === "true" : String(field.value);
      if (typeof value === "number" && !Number.isFinite(value)) throw new HttpError(400, `参数 ${field.name} 不是有效数字`);
      return [field.name, value];
    }));
    const graph = action === "run" ? await graphContext(rooms, row.room_id, row.id, request.session.user.id, params) : null;
    let outgoing;
    if (action === "poll") {
      if (!record.data.poll?.url || !record.result?.taskId) throw new HttpError(400, "尚无任务 ID 或未配置查询地址，请先提交任务");
      outgoing = { ...record.data.request, method: "GET", body: "", url: renderText(record.data.poll.url, { params, task: { id: record.result.taskId } }, true) };
    } else outgoing = { ...record.data.request, url: renderText(record.data.request.url, graph.context, true),
      body: record.data.request.method === "POST" ? requestBody(renderJson(record.data.request.body, graph.context), key, runtime, signal) : "" };
    let result;
    try { result = await (executeRequest || executePrivateRequest)(outgoing, runtime, signal); }
    catch (error) { throw error.statusCode ? error : new HttpError(signal.aborted ? 504 : 502, signal.aborted ? "API 请求超时或已取消；上游可能仍在执行，请先查询任务状态" : error.message); }
    result = { ...result, id: randomUUID(), configVersion: version, inputRevision: graph?.revision ?? record.result?.inputRevision };
    if (action === "poll") result.taskId = record.result.taskId;
    else if (record.data.poll) {
      const { json } = parseResult(result);
      const taskId = record.data.poll.taskIdPath.split("|").map((path) => atPath(json, path.trim())).find((value) => (typeof value === "string" && value) || typeof value === "number");
      if (taskId !== undefined) result.taskId = String(taskId);
    }
    return rooms.lock(row.room_id, async () => {
      await recheck();
      await db.transaction([
        { sql: "UPDATE nodes SET result_cipher=? WHERE room_id=? AND id=? AND private_version=?", params: [encrypt(key, result, `${context}:result`), row.room_id, row.id, version], expectChanges: 1 },
        auditStep(request.session.user.id, row.room_id, action === "poll" ? "private.poll" : "private.run", row.id),
      ]);
      return { result, media: resultMedia(result, record.data.category) };
    });
  }));

  app.get("/api/rooms/:roomId/private/:nodeId/media", async (request, reply) => privateIO(request, reply, async ({ record, runtime, signal, recheck }) => {
    const { path, resultId } = z.object({ path: z.string(), resultId: z.string() }).strict().parse(request.query);
    if (!record.result || record.result.id !== resultId) throw new HttpError(409, "私有结果已变化，请重新打开预览");
    const media = selectedMedia(record.result, path, record.data.category);
    const opened = await (openMedia || openResultMedia)(media.value, runtime, signal);
    try {
      const current = await recheck();
      if (privateRecord(current, key, `${current.room_id}:${current.id}:${request.session.user.id}`).result?.id !== resultId) throw new HttpError(409, "结果已变化，请重新预览");
      reply.type(opened.mime).header("Content-Disposition", "inline");
      await reply.send(opened.stream);
      return reply;
    } finally { opened.stream.destroy(); }
  }));

  app.post("/api/rooms/:roomId/private/:nodeId/publish", { config: writeRate }, async (request, reply) => privateIO(request, reply, async ({ row, record, runtime, signal, recheck }) => {
    const input = z.object({ resultId: z.string(), version: z.number().int().positive(), path: z.string(), kind: z.enum(["text", "media"]), title: z.string().trim().min(1) }).strict().parse(request.body);
    if (!record.result || record.result.id !== input.resultId || input.version !== record.version) throw new HttpError(409, "结果或配置已改变，请重新预览再发布");
    if (record.result.status < 200 || record.result.status >= 300) throw new HttpError(400, "失败的 API 结果不能发布");
    if (record.result.configVersion && record.result.configVersion !== record.version) throw new HttpError(409, "配置已修改，请先重新执行再发布");
    const publicValue = JSON.parse(row.public_json), id = randomUUID();
    const node = { id, kind: "text", position: { x: publicValue.position.x + publicValue.width + 48, y: publicValue.position.y }, width: 360, height: 280, title: input.title, content: "", fileId: null };
    let file;
    try {
      if (input.kind === "text") {
        const selected = input.path === "$text" ? parseResult(record.result).text : atPath(parseResult(record.result).json, input.path);
        if (selected === undefined) throw new HttpError(400, "结果字段不存在，请检查字段路径");
        node.content = typeof selected === "string" ? selected : JSON.stringify(selected, null, 2);
        if (Buffer.byteLength(JSON.stringify(node)) > config.MAX_SYNC_BYTES) throw new HttpError(413, "所选结果超过单次同步上限，请选择较小的字段");
      } else {
        const media = selectedMedia(record.result, input.path, record.data.category);
        const opened = await (openMedia || openResultMedia)(media.value, runtime, signal);
        file = { id: randomUUID(), mime: opened.mime };
        try { file.size = await saveEncryptedFile(opened.stream, file.id, key, runtime); }
        finally { opened.stream.destroy(); }
        node.fileId = file.id;
        node.kind = file.mime.startsWith("image/") ? "image" : file.mime.startsWith("video/") ? "video" : "file";
      }
      await recheck();
      if (file) await db.run("INSERT INTO files(id,room_id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?,?)", [file.id, row.room_id, request.session.user.id, file.mime, file.size, Date.now()]);
      return await rooms.apply(row.room_id, request.session.user.id, { operationId: randomUUID(), operations: [{ type: "create", node }] }, async () => {
        const current = await recheck();
        if (privateRecord(current, key, `${row.room_id}:${row.id}:${request.session.user.id}`).result?.id !== input.resultId) throw new HttpError(409, "私有结果已改变，取消本次发布");
      });
    } catch (error) {
      if (file) {
        await db.run("DELETE FROM files WHERE id=? AND room_id=?", [file.id, row.room_id]);
        await unlink(join(config.FILES_DIR, `${file.id}.enc`)).catch(() => {});
      }
      throw error;
    }
  }));
}
