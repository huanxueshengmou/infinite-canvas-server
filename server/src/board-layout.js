import { HttpError } from "./rooms.js";

export function validateBoardNode(node) {
  if (node.drawing && node.kind !== "whiteboard") throw new HttpError(400, "只有白板节点可以保存笔迹");
  if (["group", "whiteboard"].includes(node.kind) && node.fileId) throw new HttpError(400, "分组和白板不能作为文件节点");
  if (node.groupId && ["group", "private"].includes(node.kind)) throw new HttpError(400, "分组仅包含公开节点，不嵌套其他分组");
}

export function validateBoardLayout(nodes) {
  for (const row of nodes.values()) {
    const node = JSON.parse(row.public_json);
    validateBoardNode(node);
    if (!node.groupId) continue;
    const group = nodes.get(node.groupId);
    if (!group || JSON.parse(group.public_json).kind !== "group") throw new HttpError(400, "分组必须存在于当前画布；删除分组时请同时移出组内节点");
  }
}
