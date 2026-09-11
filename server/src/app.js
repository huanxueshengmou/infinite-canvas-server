import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import serveStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { stat, mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { z, ZodError } from "zod";
import { getConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { loadMasterKey, hashPassword, verifyPassword, token, digest, encrypt } from "./crypto.js";
import { credentialsSchema, mutationSchema, privateSchema, idSchema, publicNode, publicEdge } from "./schemas.js";
import { Rooms, HttpError, auditStep } from "./rooms.js";
import { safeMediaTypes } from "./egress.js";
import { privateRecord, registerWorkflowRoutes } from "./workflow-routes.js";
import { backupDatabase, checkStorage, clearDownloadCache, saveEncryptedFile, readEncryptedFile } from "./storage.js";

export async function createApp(options = {}) {
  const config = options.config || getConfig();
  await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
  const databasePath = join(config.DATA_DIR, "canvas.sqlite");
  const databaseExists = await stat(databasePath).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
  const key = await loadMasterKey(config.MASTER_KEY_FILE, !databaseExists);
  await clearDownloadCache(config);
  const db = await openDatabase(databasePath);
  const rooms = new Rooms(db, key, config);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: config.MAX_SYNC_BYTES,
    trustProxy: (address) => ["127.0.0.1", "::1"].includes(address), logController: new LogController({ disableRequestLogging: true }) });
  app.decorate("context", { config, db, rooms, key });
  const cookieName = config.secureCookies ? "__Host-canvas_session" : "canvas_session";
  const loopDelay = monitorEventLoopDelay();
  loopDelay.enable();
  let ioActive = 0;
  const downloadQueue = [];
  let backupActive;
  let lastBackup = null;
  let backupError = null;

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"], mediaSrc: ["'self'", "blob:"], objectSrc: ["'none'"],
        frameSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: config.secureCookies ? [] : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    hsts: config.secureCookies,
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: config.MAX_FILE_BYTES, files: 1, fields: 0 } });

  const rate = (max, byUser = false) => ({ rateLimit: { max, timeWindow: "1 minute", keyGenerator: (request) => byUser ? request.session?.user.id || request.ip : request.ip } });
  const writeRate = rate(config.WRITES_PER_MINUTE, true);
  const authRate = rate(config.AUTH_ATTEMPTS_PER_MINUTE);

  async function sessionFromCookie(header) {
    const raw = app.parseCookie(header || "")[cookieName];
    if (!raw) throw new HttpError(401, "请先登录");
    const hash = digest(raw);
    const row = await db.get(`SELECT u.id,u.username,u.admin,s.expires_at FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?`, [hash, Date.now()]);
    if (!row) throw new HttpError(401, "登录已过期，请重新登录");
    return { hash, csrf: digest(`${raw}:csrf`), expiresAt: row.expires_at, user: { id: row.id, username: row.username, admin: Boolean(row.admin) } };
  }

  async function startSession(user, reply) {
    const raw = token(), expiresAt = Date.now() + config.SESSION_TTL_MS;
    await db.run("INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)", [digest(raw), user.id, expiresAt]);
    reply.setCookie(cookieName, raw, { httpOnly: true, secure: config.secureCookies, sameSite: "strict", path: "/", expires: new Date(expiresAt) });
    return { user: { id: user.id, username: user.username, admin: Boolean(user.admin) }, csrf: digest(`${raw}:csrf`), expiresAt };
  }

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/") && pathname !== "/health") return;
    reply.header("Cache-Control", "no-store");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutating && request.headers.origin !== config.APP_ORIGIN) throw new HttpError(403, "请求来源不受信任");
    if (["/api/meta", "/api/auth/login", "/api/auth/register", "/health"].includes(pathname)) return;
    request.session = await sessionFromCookie(request.headers.cookie);
    if (mutating && request.headers["x-csrf-token"] !== request.session.csrf) throw new HttpError(403, "安全验证已失效，请刷新页面");
  });
  app.addHook("preHandler", async (request) => {
    // Recheck after reading a body: a slow upload cannot retain an expired/login-revoked session.
    if (request.session) request.session = await sessionFromCookie(request.headers.cookie);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "请求字段无效，请检查输入内容" });
    const status = error.statusCode || (error.message === "CONFLICT" ? 409 : 500);
    if (status >= 500 && status !== 503) app.log.error({ code: error.code || "INTERNAL" }, "Request failed");
    const message = status === 500 ? "服务暂时不可用，数据未确认保存" : error.message;
    reply.code(status).send({ error: message, ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });

  const runIO = async (task, queueDownload = false) => {
    if (ioActive >= config.API_CONCURRENCY) {
      if (!queueDownload || downloadQueue.length >= config.MAX_ROOM_CONNECTIONS) throw new HttpError(429, "文件或 API 处理繁忙，请稍后再试");
      await new Promise((resolve) => downloadQueue.push(resolve));
    } else ioActive++;
    try { return await task(); }
    finally {
      const next = downloadQueue.shift();
      if (next) next(); else ioActive--;
    }
  };
  const admin = (request) => { if (!request.session.user.admin) throw new HttpError(403, "需要管理员权限"); };
  const uploadLimit = async () => {
    const setting = await db.get("SELECT value FROM settings WHERE key='max_file_bytes'");
    return setting ? z.number().int().positive().parse(JSON.parse(setting.value)) : config.MAX_FILE_BYTES;
  };
  const validateRoom = (request) => idSchema.parse(request.params.roomId);
  const backup = () => {
    if (backupActive) return backupActive;
    backupActive = backupDatabase(db, key, config).then((result) => { lastBackup = result; backupError = null; return result; }, (error) => { backupError = "云盘备份失败，请检查挂载和剩余空间"; throw error; }).finally(() => { backupActive = null; });
    return backupActive;
  };

  app.get("/health", async () => {
    await db.get("SELECT 1");
    await checkStorage(config);
    return { status: "ok" };
  });
  app.get("/api/meta", async () => ({
    maxRoomConnections: config.MAX_ROOM_CONNECTIONS, maxSyncBytes: config.MAX_SYNC_BYTES,
    maxFileBytes: await uploadLimit(), syncBatchMs: config.SYNC_BATCH_MS,
    shareTtlMs: config.SHARE_TTL_MS, apiTimeoutMs: config.API_TIMEOUT_MS,
  }));
  app.get("/api/auth/session", async (request) => ({ user: request.session.user, csrf: request.session.csrf, expiresAt: request.session.expiresAt }));

  app.post("/api/auth/login", { config: authRate }, async (request, reply) => {
    const input = credentialsSchema.parse(request.body);
    const user = await db.get("SELECT * FROM users WHERE username=?", [input.username.toLowerCase()]);
    const valid = await verifyPassword(input.password, user?.password_hash || dummyPassword);
    if (!user || !valid) throw new HttpError(401, "用户名或密码不正确");
    return startSession(user, reply);
  });

  async function getShare(raw, password) {
    const share = await db.get("SELECT * FROM shares WHERE hash=? AND revoked=0 AND expires_at>?", [digest(raw), Date.now()]);
    if (!share) throw new HttpError(403, "分享无效或已过期");
    if (share.password_hash && !(await verifyPassword(password || "", share.password_hash))) throw new HttpError(403, "分享无效或口令不正确");
    return share;
  }
  const inviteSchema = z.object({ token: z.string().min(1), password: z.string().default("") }).strict();
  const registrationSchema = credentialsSchema.extend({ inviteToken: z.string().min(1).optional(), invitePassword: z.string().default("") }).strict();
  app.post("/api/auth/register", { config: authRate }, async (request, reply) => {
    const input = registrationSchema.parse(request.body);
    const share = input.inviteToken ? await getShare(input.inviteToken, input.invitePassword) : null;
    const passwordHash = await hashPassword(input.password);
    const user = { id: randomUUID(), username: input.username.toLowerCase(), admin: false };
    const createAccount = async () => {
      const current = share ? await getShare(input.inviteToken, input.invitePassword) : null;
      try {
        await db.transaction([
          { sql: "INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?) ON CONFLICT(username) DO NOTHING", params: [user.id, user.username, passwordHash, Date.now()], expectChanges: 1 },
          ...(current ? [
            { sql: "INSERT INTO members(room_id,user_id,role,share_id) VALUES(?,?,?,?)", params: [current.room_id, user.id, current.role, current.id] },
            auditStep(user.id, current.room_id, "member.join", current.id),
          ] : []),
        ]);
      } catch (error) {
        if (error.message === "CONFLICT") throw new HttpError(409, "该用户名无法注册，请换一个名称");
        throw error;
      }
    };
    if (share) await rooms.lock(share.room_id, createAccount);
    else await createAccount();
    return { ...(await startSession(user, reply)), ...(share ? { roomId: share.room_id } : {}) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await db.run("DELETE FROM sessions WHERE hash=?", [request.session.hash]);
    rooms.logout(request.session.hash);
    reply.clearCookie(cookieName, { path: "/", secure: config.secureCookies, httpOnly: true, sameSite: "strict" });
    return { ok: true };
  });
  app.post("/api/auth/password", { config: authRate }, async (request, reply) => {
    const input = z.object({ oldPassword: z.string(), newPassword: z.string().min(12) }).strict().parse(request.body);
    const user = await db.get("SELECT * FROM users WHERE id=?", [request.session.user.id]);
    if (!(await verifyPassword(input.oldPassword, user.password_hash))) throw new HttpError(403, "原密码不正确");
    const hashed = await hashPassword(input.newPassword);
    const sessions = await db.all("SELECT hash FROM sessions WHERE user_id=?", [user.id]);
    await db.transaction([
      { sql: "UPDATE users SET password_hash=? WHERE id=?", params: [hashed, user.id] },
      { sql: "DELETE FROM sessions WHERE user_id=?", params: [user.id] },
    ]);
    for (const session of sessions) rooms.logout(session.hash);
    return startSession(user, reply);
  });

  app.get("/api/rooms", async (request) => db.all(`SELECT DISTINCT r.id,r.title,r.created_at,
    CASE WHEN r.owner_id=? THEN 'owner' ELSE m.role END AS role
    FROM rooms r LEFT JOIN members m ON m.room_id=r.id AND m.user_id=? LEFT JOIN shares s ON s.id=m.share_id
    WHERE r.owner_id=? OR (m.user_id=? AND (m.share_id IS NULL OR (s.revoked=0 AND s.expires_at>?))) ORDER BY r.created_at DESC`,
    [request.session.user.id, request.session.user.id, request.session.user.id, request.session.user.id, Date.now()]));
  app.post("/api/rooms", { config: writeRate }, async (request) => {
    const { title } = z.object({ title: z.string().trim().min(1) }).strict().parse(request.body);
    const room = { id: randomUUID(), title, role: "owner", created_at: Date.now() };
    await db.transaction([
      { sql: "INSERT INTO rooms(id,title,owner_id,created_at) VALUES(?,?,?,?)", params: [room.id, room.title, request.session.user.id, room.created_at] },
      auditStep(request.session.user.id, room.id, "room.create"),
    ]);
    return room;
  });
  app.post("/api/shares/join", { config: authRate }, async (request) => {
    const input = inviteSchema.parse(request.body), share = await getShare(input.token, input.password);
    return rooms.lock(share.room_id, async () => {
      const current = await getShare(input.token, input.password);
      const room = await db.get("SELECT owner_id FROM rooms WHERE id=?", [current.room_id]);
      if (room.owner_id !== request.session.user.id) {
        await db.transaction([
          { sql: `INSERT INTO members(room_id,user_id,role,share_id) VALUES(?,?,?,?)
            ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role,share_id=excluded.share_id`, params: [current.room_id, request.session.user.id, current.role, current.id] },
          auditStep(request.session.user.id, current.room_id, "member.join", current.id),
        ]);
        rooms.disconnect(current.room_id, request.session.user.id);
      }
      return { roomId: current.room_id };
    });
  });

  app.get("/api/rooms/:roomId", async (request) => {
    const roomId = validateRoom(request);
    return rooms.lock(roomId, async () => {
      const access = await rooms.access(roomId, request.session.user.id);
      const nodes = await db.all("SELECT id,owner_id,visibility,version,public_json FROM nodes WHERE room_id=?", [roomId]);
      const edges = await db.all("SELECT * FROM edges WHERE room_id=?", [roomId]);
      return { id: roomId, title: access.title, role: access.role, revision: access.revision,
        nodes: nodes.map(publicNode), edges: edges.map(publicEdge), ownPrivateIds: nodes.filter((row) => row.visibility === "private" && row.owner_id === request.session.user.id).map((row) => row.id) };
    });
  });
  app.post("/api/rooms/:roomId/operations", { config: writeRate }, async (request) => {
    await checkStorage(config);
    return rooms.apply(validateRoom(request), request.session.user.id, mutationSchema.parse(request.body));
  });

  app.get("/api/rooms/:roomId/shares", async (request) => {
    const roomId = validateRoom(request);
    rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
    return db.all("SELECT id,role,expires_at,revoked,created_at,(password_hash IS NOT NULL) AS protected FROM shares WHERE room_id=? ORDER BY created_at DESC", [roomId]);
  });
  app.post("/api/rooms/:roomId/shares", { config: writeRate }, async (request) => {
    const roomId = validateRoom(request);
    const input = z.object({ role: z.enum(["viewer", "editor"]), password: z.string().default(""), expiresAt: z.number().int().positive().optional() }).strict().parse(request.body);
    const expiresAt = input.expiresAt || Date.now() + config.SHARE_TTL_MS;
    if (expiresAt <= Date.now()) throw new HttpError(400, "分享过期时间必须在将来");
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    return rooms.lock(roomId, async () => {
      rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
      const raw = token(), id = randomUUID();
      await db.transaction([
        { sql: "INSERT INTO shares(id,room_id,hash,role,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)", params: [id, roomId, digest(raw), input.role, passwordHash, expiresAt, Date.now()] },
        auditStep(request.session.user.id, roomId, "share.create", id),
      ]);
      return { id, token: raw, expiresAt, role: input.role };
    });
  });
  app.delete("/api/rooms/:roomId/shares/:shareId", { config: writeRate }, async (request) => {
    const roomId = validateRoom(request), shareId = idSchema.parse(request.params.shareId);
    return rooms.lock(roomId, async () => {
      rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
      await db.transaction([
        { sql: "UPDATE shares SET revoked=1 WHERE id=? AND room_id=?", params: [shareId, roomId] },
        auditStep(request.session.user.id, roomId, "share.revoke", shareId),
      ]);
      const affected = await db.all("SELECT user_id FROM members WHERE room_id=? AND share_id=?", [roomId, shareId]);
      for (const member of affected) rooms.disconnect(roomId, member.user_id);
      return { ok: true };
    });
  });
  app.get("/api/rooms/:roomId/members", async (request) => {
    const roomId = validateRoom(request);
    rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
    return db.all(`SELECT u.id,u.username,m.role,m.share_id,s.expires_at,s.revoked FROM members m
      JOIN users u ON u.id=m.user_id LEFT JOIN shares s ON s.id=m.share_id WHERE m.room_id=?`, [roomId]);
  });
  app.patch("/api/rooms/:roomId/members/:userId", { config: writeRate }, async (request) => {
    const roomId = validateRoom(request), userId = idSchema.parse(request.params.userId);
    const { role } = z.object({ role: z.enum(["viewer", "editor"]) }).strict().parse(request.body);
    return rooms.lock(roomId, async () => {
      rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
      await db.transaction([
        { sql: "UPDATE members SET role=? WHERE room_id=? AND user_id=?", params: [role, roomId, userId], expectChanges: 1 },
        auditStep(request.session.user.id, roomId, "member.role", userId),
      ]);
      rooms.disconnect(roomId, userId);
      return { ok: true };
    });
  });
  app.delete("/api/rooms/:roomId/members/:userId", { config: writeRate }, async (request) => {
    const roomId = validateRoom(request), userId = idSchema.parse(request.params.userId);
    return rooms.lock(roomId, async () => {
      rooms.assertOwner(await rooms.access(roomId, request.session.user.id));
      await db.transaction([
        { sql: "DELETE FROM members WHERE room_id=? AND user_id=?", params: [roomId, userId] },
        auditStep(request.session.user.id, roomId, "member.remove", userId),
      ]);
      rooms.disconnect(roomId, userId);
      return { ok: true };
    });
  });

  const nodeContext = (request) => `${validateRoom(request)}:${idSchema.parse(request.params.nodeId)}:${request.session.user.id}`;
  app.get("/api/rooms/:roomId/private/:nodeId", async (request) => {
    const context = nodeContext(request);
    return rooms.lock(request.params.roomId, async () => {
      const row = await rooms.privateNode(request.params.roomId, request.params.nodeId, request.session.user.id);
      return privateRecord(row, key, context);
    });
  });
  app.put("/api/rooms/:roomId/private/:nodeId", { config: writeRate }, async (request) => {
    const context = nodeContext(request);
    const input = z.object({ version: z.number().int().positive(), data: privateSchema }).strict().parse(request.body);
    await checkStorage(config);
    return rooms.lock(request.params.roomId, async () => {
      const row = await rooms.privateNode(request.params.roomId, request.params.nodeId, request.session.user.id, true);
      if (input.version !== row.private_version) throw new HttpError(409, "隐私节点已在其他窗口修改，草稿已保留");
      await db.transaction([
        { sql: "UPDATE nodes SET private_cipher=?,private_version=private_version+1 WHERE room_id=? AND id=? AND private_version=?", params: [encrypt(key, input.data, context), row.room_id, row.id, input.version], expectChanges: 1 },
        auditStep(request.session.user.id, row.room_id, "private.save", row.id),
      ]);
      return { version: row.private_version + 1 };
    });
  });
  registerWorkflowRoutes(app, { runIO, writeRate, sessionFromCookie, uploadLimit, executeRequest: options.executeRequest, openMedia: options.openMedia });

  app.post("/api/rooms/:roomId/files", { config: writeRate }, async (request) => runIO(async () => {
    const roomId = validateRoom(request);
    rooms.assertEditor(await rooms.access(roomId, request.session.user.id));
    const part = await request.file({ limits: { fileSize: await uploadLimit() } });
    if (!part) throw new HttpError(400, "请选择一个文件");
    const id = randomUUID();
    const size = await saveEncryptedFile(part.file, id, key, config);
    const mime = safeMediaTypes.includes(part.mimetype) ? part.mimetype : "application/octet-stream";
    try {
      await rooms.lock(roomId, async () => {
        await sessionFromCookie(request.headers.cookie);
        rooms.assertEditor(await rooms.access(roomId, request.session.user.id));
        await db.run("INSERT INTO files(id,room_id,owner_id,mime,size,created_at) VALUES(?,?,?,?,?,?)", [id, roomId, request.session.user.id, mime, size, Date.now()]);
      });
    } catch (error) {
      await unlink(join(config.FILES_DIR, `${id}.enc`)).catch(() => {});
      throw error;
    }
    return { id, mime, size };
  }));
  app.get("/api/rooms/:roomId/files/:fileId", async (request, reply) => runIO(async () => {
    const roomId = validateRoom(request), id = idSchema.parse(request.params.fileId);
    await sessionFromCookie(request.headers.cookie);
    await rooms.access(roomId, request.session.user.id);
    const file = await db.get("SELECT * FROM files WHERE room_id=? AND id=?", [roomId, id]);
    if (!file) throw new HttpError(404, "文件不存在");
    const controller = new AbortController();
    const active = { controller, roomId, userId: request.session.user.id, sessionHash: request.session.hash };
    const abort = () => controller.abort();
    reply.raw.once("close", abort);
    rooms.runningRequests.add(active);
    let data;
    try {
      if (reply.raw.destroyed) controller.abort();
      data = await readEncryptedFile(id, key, config, file.size, controller.signal);
      await sessionFromCookie(request.headers.cookie);
      const access = await rooms.access(roomId, request.session.user.id);
      controller.signal.throwIfAborted();
      const timer = setTimeout(abort, Math.max(1, Math.min(request.session.expiresAt, access.accessUntil) - Date.now()));
      controller.signal.addEventListener("abort", () => data.stream.destroy(), { once: true });
      try {
        reply.type(file.mime).header("Content-Length", file.size).header("Content-Disposition", `${safeMediaTypes.includes(file.mime) ? "inline" : "attachment"}; filename="${id}"`);
        await reply.send(data.stream);
        return reply;
      } finally { clearTimeout(timer); }
    } finally {
      if (data) await data.cleanup();
      rooms.runningRequests.delete(active);
      reply.raw.off("close", abort);
    }
  }, true));

  app.get("/api/admin/settings", async (request) => { admin(request); return { maxFileBytes: await uploadLimit() }; });
  app.put("/api/admin/settings", { config: writeRate }, async (request) => {
    admin(request);
    const input = z.object({ maxFileBytes: z.number().int().positive().multipleOf(1048576) }).strict().parse(request.body);
    await db.transaction([
      { sql: "INSERT INTO settings(key,value) VALUES('max_file_bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [JSON.stringify(input.maxFileBytes)] },
      auditStep(request.session.user.id, null, "settings.upload-limit"),
    ]);
    return input;
  });

  app.get("/api/admin/status", async (request) => {
    admin(request);
    return { memory: process.memoryUsage(), databaseQueue: db.pending, ioActive, rooms: rooms.clients.size,
      eventLoopDelayMs: { p95: loopDelay.percentile(95) / 1e6, max: loopDelay.max / 1e6 }, lastBackup, backupError };
  });
  app.post("/api/admin/backup", { config: writeRate }, async (request) => { admin(request); return { backup: await backup() }; });
  app.get("/api/admin/providers", async (request) => {
    admin(request);
    const setting = await db.get("SELECT value FROM settings WHERE key='api_hosts'");
    return { hosts: setting ? JSON.parse(setting.value) : config.allowedHosts };
  });
  app.put("/api/admin/providers", { config: writeRate }, async (request) => {
    admin(request);
    const { hosts } = z.object({ hosts: z.array(z.hostname()) }).strict().parse(request.body);
    await db.run("INSERT INTO settings(key,value) VALUES('api_hosts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify([...new Set(hosts.map((host) => host.toLowerCase()))])]);
    return { ok: true };
  });

  app.server.on("upgrade", async (request, socket, head) => {
    socket.on("error", () => {});
    try {
      if (request.headers.origin !== config.APP_ORIGIN) throw new HttpError(403, "Origin rejected");
      const match = /^\/api\/rooms\/([a-f0-9-]+)\/events$/.exec(request.url || "");
      if (!match) throw new HttpError(404, "Not found");
      idSchema.parse(match[1]);
      const session = await sessionFromCookie(request.headers.cookie);
      await rooms.connect(request, socket, head, session, match[1]);
    } catch (error) {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.statusCode || 400} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });

  if (config.STATIC_DIR) {
    app.get("/", (_request, reply) => reply.redirect("/collaboration"));
    await app.register(serveStatic, { root: resolve(config.STATIC_DIR), index: false, dotfiles: "deny" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.method !== "GET") return reply.code(404).send({ error: "接口不存在" });
      return reply.header("Cache-Control", "no-store").sendFile("index.html");
    });
  }
  const dummyPassword = await hashPassword(token());
  const backupTimer = config.BACKUP_DIR ? setInterval(() => { void backup().catch(() => {}); }, config.BACKUP_INTERVAL_MS) : null;
  backupTimer?.unref();
  app.addHook("onClose", async () => {
    if (backupTimer) clearInterval(backupTimer);
    loopDelay.disable();
    await rooms.close();
    if (backupActive) await backupActive.catch(() => {});
    await db.close();
  });
  return app;
}
