import { randomUUID } from "node:crypto";
import { decrypt } from "./crypto.js";
import { HttpError } from "./rooms.js";
import { readEncryptedFile } from "./storage.js";

export function atPath(value, path) {
  if (!path) return value;
  for (const part of path.split(".")) {
    if (!/^[\w-]+$/.test(part) || ["__proto__", "prototype", "constructor"].includes(part) || value == null || !Object.hasOwn(Object(value), part)) return undefined;
    value = value[part];
  }
  return value;
}

export function parseResult(result) {
  let json;
  try { json = JSON.parse(result.text); } catch { json = undefined; }
  const text = atPath(json, "choices.0.message.content");
  return { text: typeof text === "string" ? text : result.text, json };
}

export function resultMedia(result, category = "image") {
  const { json } = parseResult(result), media = [], pending = [{ value: json, path: "" }];
  while (pending.length) {
    const { value, path } = pending.pop();
    if (typeof value === "string") {
      if (/^data:(image|video|audio)\/[a-zA-Z0-9.+-]+;base64,/.test(value)) media.push({ path, type: value.slice(5).split("/")[0] });
      else if (/^https:\/\//.test(value) && /(?:^|\.)(url|video_url|audio_url|image_url|output_url|result_url)$/.test(path)) media.push({ path, type: path.includes("video") ? "video" : path.includes("audio") ? "audio" : category === "video" ? "video" : "image" });
      else if (/(?:^|\.)b64_json$/.test(path) && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) media.push({ path, type: "image", base64: true });
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value).reverse()) pending.push({ value: value[key], path: path ? `${path}.${key}` : key });
    }
  }
  return media;
}

export function selectedMedia(result, path, category) {
  const candidate = resultMedia(result, category).find((item) => item.path === path);
  if (!candidate) throw new HttpError(400, "所选字段不是可预览的图片、视频或音频地址");
  const value = atPath(parseResult(result).json, path);
  return { ...candidate, value: candidate.base64 ? `data:image/png;base64,${value}` : value };
}

export class FileInput {
  constructor(file) { this.file = file; }
}

function placeholder(context, expression) {
  const optional = expression.endsWith("?");
  const path = optional ? expression.slice(0, -1) : expression;
  const value = atPath(context, path);
  if (value === undefined && !optional) throw new HttpError(400, `缺少输入 ${path}，请连接上游节点或填写参数`);
  return value;
}

export function renderText(template, context, url = false) {
  return template.replace(/\{\{\s*([\w.]+\??)\s*\}\}/g, (_match, path) => {
    const value = placeholder(context, path);
    if (value instanceof FileInput) throw new HttpError(400, "附件需要在 JSON 或表单中使用完整占位符");
    const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return url ? encodeURIComponent(text) : text;
  });
}

export function renderJson(template, context) {
  let value;
  try { value = JSON.parse(template); } catch { throw new HttpError(400, "请求正文或自定义 JSON 模板不是有效的 JSON"); }
  // JSON.parse/stringify handle escaping. Templates never run code or access object prototypes.
  const visit = (item) => {
    if (typeof item === "string") {
      const exact = /^\{\{\s*([\w.]+\??)\s*\}\}$/.exec(item);
      return exact ? placeholder(context, exact[1]) : renderText(item, context);
    }
    if (Array.isArray(item)) return item.map(visit).filter((child) => child !== undefined);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]).filter(([, child]) => child !== undefined));
    return item;
  };
  return visit(value);
}

// Only the small JSON skeleton is buffered. Referenced attachments are authenticated,
// then base64-encoded as a stream; a 500 MiB file never becomes one enormous JS string.
export function requestBody(value, key, config, signal) {
  const files = new Map();
  const json = JSON.stringify(value, (_key, item) => {
    if (!(item instanceof FileInput)) return item;
    const marker = `canvas-file-${randomUUID()}`;
    files.set(marker, item.file);
    return marker;
  });
  if (!files.size) return json;
  return (async function* () {
    const pattern = new RegExp([...files.keys()].join("|"), "g");
    let offset = 0;
    for (const match of json.matchAll(pattern)) {
      signal.throwIfAborted();
      yield json.slice(offset, match.index);
      const file = files.get(match[0]);
      yield `data:${file.mime};base64,`;
      const data = await readEncryptedFile(file.id, key, config, file.size, signal);
      try {
        data.stream.setEncoding("base64");
        for await (const chunk of data.stream) { signal.throwIfAborted(); yield chunk; }
      } finally { await data.cleanup(); }
      offset = match.index + match[0].length;
    }
    yield json.slice(offset);
  })();
}

export async function graphContext(rooms, roomId, nodeId, userId, params = {}) {
  const { db, key, config } = rooms;
  const snapshot = await rooms.lock(roomId, async () => {
    const access = await rooms.access(roomId, userId);
    const nodes = new Map((await db.all("SELECT id,owner_id,visibility,version,private_version,public_json FROM nodes WHERE room_id=?", [roomId])).map((row) => [row.id, row]));
    const edges = await db.all("SELECT * FROM edges WHERE room_id=?", [roomId]);
    return { nodes, edges, revision: access.revision };
  });
  if (!snapshot.nodes.has(nodeId)) throw new HttpError(404, "节点不存在");
  const incoming = new Map();
  for (const edge of snapshot.edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
  }
  const needed = new Set(), pending = [nodeId];
  while (pending.length) {
    const id = pending.pop();
    if (needed.has(id)) continue;
    needed.add(id);
    // A completed API node is a cached output, not a request to rerun its ancestors.
    if (id !== nodeId && snapshot.nodes.get(id)?.visibility === "private") continue;
    for (const edge of incoming.get(id) || []) pending.push(edge.source);
  }
  const counts = new Map(), successors = new Map();
  for (const id of needed) counts.set(id, 0);
  for (const edge of snapshot.edges) if (needed.has(edge.target) && needed.has(edge.source) && (edge.target === nodeId || snapshot.nodes.get(edge.target)?.visibility !== "private")) {
    counts.set(edge.target, counts.get(edge.target) + 1);
    if (!successors.has(edge.source)) successors.set(edge.source, []);
    successors.get(edge.source).push(edge.target);
  }
  const queue = [...counts].filter(([, count]) => count === 0).map(([id]) => id), outputs = new Map();
  const inputFor = (id) => {
    const context = { params, input: { text: String(params.prompt ?? "") }, image: {}, audio: {} };
    for (const edge of incoming.get(id) || []) context[edge.target_port] = outputs.get(edge.source);
    return context;
  };
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index], row = snapshot.nodes.get(id);
    if (id !== nodeId) {
      if (!row) throw new HttpError(409, "上游节点已删除，请重新连接");
      if (row.visibility === "private") {
        if (row.owner_id !== userId) throw new HttpError(403, "不能读取他人的隐私输出");
        if (snapshot.nodes.get(nodeId).visibility !== "private") throw new HttpError(403, "公共节点不能读取隐私输出");
        const stored = await db.get("SELECT private_cipher,result_cipher,private_version FROM nodes WHERE room_id=? AND id=? AND owner_id=?", [roomId, id, userId]);
        if (!stored?.result_cipher) throw new HttpError(409, "请先执行上游隐私节点");
        if (stored.private_version !== row.private_version) throw new HttpError(409, "上游配置正在改变，请稍后重试");
        const result = decrypt(key, stored.result_cipher, `${roomId}:${id}:${userId}:result`);
        if (result.status < 200 || result.status >= 300) throw new HttpError(409, "上游隐私请求未成功，请先处理上游错误");
        if (result.configVersion && result.configVersion !== row.private_version) throw new HttpError(409, "上游隐私配置已修改，请重新执行上游节点");
        const data = decrypt(key, stored.private_cipher, `${roomId}:${id}:${userId}`);
        const media = resultMedia(result, data.category)[0];
        outputs.set(id, { ...parseResult(result), ...(media ? { dataUrl: selectedMedia(result, media.path, data.category).value } : {}) });
      } else {
        const node = JSON.parse(row.public_json);
        if (node.kind === "custom") outputs.set(id, evaluateCustom(node, inputFor(id), config));
        else if (node.fileId) {
          const file = await db.get("SELECT * FROM files WHERE room_id=? AND id=?", [roomId, node.fileId]);
          if (!file) throw new HttpError(409, "上游文件不存在");
          outputs.set(id, { text: node.title, fileId: file.id, mime: file.mime, dataUrl: new FileInput(file) });
        } else outputs.set(id, { text: node.content });
      }
    }
    for (const next of successors.get(id) || []) {
      counts.set(next, counts.get(next) - 1);
      if (!counts.get(next)) queue.push(next);
    }
  }
  if (queue.length !== needed.size) throw new HttpError(409, "工作流中存在循环，无法执行");
  return { context: inputFor(nodeId), revision: snapshot.revision, node: snapshot.nodes.get(nodeId) };
}

export function evaluateCustom(node, context, config) {
  const json = node.outputType === "json" ? renderJson(node.content, context) : undefined;
  // Shared outputs cannot include attachment bytes; references remain file IDs.
  const text = json === undefined ? renderText(node.content, context) : JSON.stringify(json, (_key, value) => {
    if (value instanceof FileInput) throw new HttpError(400, "公共 JSON 请使用 image.fileId / audio.fileId，附件字节只能送入隐私 API 请求");
    return value;
  }, 2);
  if (Buffer.byteLength(text) > config.MAX_SYNC_BYTES) throw new HttpError(413, "自定义节点输出超过单次同步大小限制，请缩小输入或模板");
  return { text, ...(json === undefined ? {} : { json }) };
}
