import { HttpError } from "./rooms.js";

export function assertEdgeOwner(edge, nodes, userId) {
  for (const id of [edge.source, edge.target]) {
    const node = nodes.get(id);
    if (node?.visibility === "private" && node.owner_id !== userId) throw new HttpError(403, "只能连接或断开自己的隐私节点");
  }
}

export function validateGraph(edges, nodes) {
  const slots = new Set(), successors = new Map(), indegree = new Map();
  for (const edge of edges.values()) {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target) throw new HttpError(400, "连线两端必须是当前画布中存在的节点");
    const from = JSON.parse(source.public_json), to = JSON.parse(target.public_json);
    if (["whiteboard", "group"].includes(from.kind) || ["whiteboard", "group"].includes(to.kind)) throw new HttpError(400, "白板和分组没有输入或输出端口");
    if (!["custom", "private"].includes(to.kind)) throw new HttpError(400, "请连接到自定义节点或自己的隐私节点的输入端口");
    if (source.visibility === "private" && (target.visibility !== "private" || source.owner_id !== target.owner_id)) throw new HttpError(403, "隐私输出只能传给自己的隐私节点；公开前请使用发布结果并确认");
    if (edge.target_port === "image" && !["image", "private"].includes(from.kind)) throw new HttpError(400, "图片输入需要图片节点或自己的隐私结果");
    if (edge.target_port === "audio" && !["file", "private"].includes(from.kind)) throw new HttpError(400, "音频输入需要音频文件或自己的隐私结果");
    const slot = `${edge.target}:${edge.target_port}`;
    if (slots.has(slot)) throw new HttpError(409, "该输入端口已有连线，请先断开或重连");
    slots.add(slot);
    if (!successors.has(edge.source)) successors.set(edge.source, []);
    successors.get(edge.source).push(edge.target);
    if (!indegree.has(edge.source)) indegree.set(edge.source, 0);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; visited++;
    for (const next of successors.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (!indegree.get(next)) queue.push(next);
    }
  }
  if (visited !== indegree.size) throw new HttpError(400, "连线不能形成循环，请先断开回路");
}
