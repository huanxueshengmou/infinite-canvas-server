import { getGroupWrapRect } from "@/lib/canvas/canvas-node-geometry";
import type { NodeFields, NodeOperation, SharedNode } from "@/services/api/collaboration";

export type BoardEdit = { id: string; fields: NodeFields };
const wrap = (members: SharedNode[]) => { const { x, y, width, height } = getGroupWrapRect(members); return { position: { x, y }, width, height }; };

export function layoutNodes(nodes: SharedNode[]) {
    return nodes.map((node) => {
        if (node.kind !== "group") return node;
        const members = nodes.filter((item) => item.groupId === node.id);
        return members.length ? { ...node, ...wrap(members) } : node;
    }).sort((a, b) => Number(b.kind === "group") - Number(a.kind === "group"));
}

export function expandGroups(ids: Set<string>, nodes: SharedNode[]) {
    const groups = new Set(nodes.filter((node) => ids.has(node.id) && node.kind === "group").map((node) => node.id));
    return nodes.filter((node) => ids.has(node.id) || (node.groupId && groups.has(node.groupId)));
}

export function editsWithGroupBounds(nodes: SharedNode[], edits: BoardEdit[]) {
    const changes = new Map(edits.map((edit) => [edit.id, edit.fields])), groups = new Set<string>();
    for (const node of nodes) {
        const fields = changes.get(node.id);
        if (!fields || !["position", "width", "height", "groupId"].some((field) => Object.hasOwn(fields, field))) continue;
        if (node.groupId) groups.add(node.groupId);
        if (fields.groupId) groups.add(fields.groupId);
        if (node.kind === "group") groups.add(node.id);
    }
    const next = nodes.map((node) => ({ ...node, ...changes.get(node.id) }));
    for (const id of groups) {
        const group = next.find((node) => node.id === id && node.kind === "group"), members = next.filter((node) => node.groupId === id);
        if (!group || !members.length) continue;
        const bounds = wrap(members);
        if (group.position.x !== bounds.position.x || group.position.y !== bounds.position.y || group.width !== bounds.width || group.height !== bounds.height) changes.set(id, { ...changes.get(id), ...bounds });
    }
    return [...changes].map(([id, fields]) => ({ id, fields }));
}

export function containingGroup(node: Pick<SharedNode, "position" | "width" | "height">, nodes: SharedNode[], except?: string | null) {
    const x = node.position.x + node.width / 2, y = node.position.y + node.height / 2;
    return [...layoutNodes(nodes)].reverse().find((group) => group.kind === "group" && group.id !== except && x >= group.position.x && x <= group.position.x + group.width && y >= group.position.y && y <= group.position.y + group.height)?.id;
}

export function groupSelection(ids: Set<string>, nodes: SharedNode[]) {
    const selected = expandGroups(ids, nodes), members = selected.filter((node) => node.kind !== "group");
    if (!members.length) throw new Error("请先选择要编组的节点");
    if (members.some((node) => node.kind === "private")) throw new Error("请仅选择公开节点进行编组");
    const id = crypto.randomUUID();
    const operations: NodeOperation[] = [{ type: "create", node: { id, kind: "group", title: "画布组", content: "", fileId: null, ...wrap(members) } },
        ...members.map((node): NodeOperation => ({ type: "update", id: node.id, version: node.version, fields: { groupId: id } })),
        ...selected.filter((node) => node.kind === "group").map((node): NodeOperation => ({ type: "delete", id: node.id, version: node.version }))];
    return { id, operations };
}

export function ungroupSelection(ids: Set<string>, nodes: SharedNode[]) {
    const groups = nodes.filter((node) => ids.has(node.id) && node.kind === "group");
    const members = expandGroups(ids, nodes).filter((node) => node.groupId);
    const operations: NodeOperation[] = [
        ...editsWithGroupBounds(nodes, members.map((node) => ({ id: node.id, fields: { groupId: null } }))).filter((edit) => !groups.some((group) => group.id === edit.id)).map((edit): NodeOperation => ({ type: "update", ...edit, version: nodes.find((node) => node.id === edit.id)!.version })),
        ...groups.map((node): NodeOperation => ({ type: "delete", id: node.id, version: node.version }))];
    return { ids: members.map((node) => node.id), operations };
}
