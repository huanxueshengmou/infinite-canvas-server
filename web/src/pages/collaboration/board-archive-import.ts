import { collaborationApi, emptyPrivateData, type CollaborationMeta, type NodeOperation, type SharedRoom } from "@/services/api/collaboration";
import { archiveUploadName, type ArchiveProgress, type PreparedArchive } from "./board-archive";

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function archiveOperationBatches(operations: NodeOperation[], maxBytes: number) {
    const overhead = byteLength({ operationId: "00000000-0000-4000-8000-000000000000", operations: [] });
    const batches: NodeOperation[][] = [];
    let batch: NodeOperation[] = [], size = overhead;
    for (const operation of operations) {
        const bytes = byteLength(operation);
        if (overhead + bytes > maxBytes) throw new Error("单个节点超过当前服务器的单次同步上限，请在原画布缩小该节点内容后重新导出");
        if (size + bytes + Number(batch.length > 0) > maxBytes) { batches.push(batch); batch = []; size = overhead; }
        size += bytes + Number(batch.length > 0); batch.push(operation);
    }
    if (batch.length) batches.push(batch);
    return batches;
}

export async function importBoardArchive(prepared: PreparedArchive, title: string, signal: AbortSignal, progress: ArchiveProgress, onCreated: (room: SharedRoom) => void) {
    const { archive, files } = prepared;
    const meta = await collaborationApi<CollaborationMeta>("/meta", { signal });
    for (const asset of archive.assets) {
        if (!files.has(asset.id)) throw new Error(`附件「${asset.name}」未通过校验`);
        if (asset.size > meta.maxFileBytes) throw new Error(`附件「${asset.name}」超过服务器当前单文件上限 ${meta.maxFileBytes / 1048576} MiB`);
    }
    const ids = new Map(archive.nodes.map((node) => [node.id, crypto.randomUUID()]));
    const operations: NodeOperation[] = [...archive.nodes].sort((a, b) => Number(b.kind === "group") - Number(a.kind === "group")).map((node) => ({ type: "create", node: {
        ...node, id: ids.get(node.id)!, ...(node.groupId ? { groupId: ids.get(node.groupId)! } : {}),
        ...(node.kind === "private" ? { privateData: emptyPrivateData() } : {}),
    } }));
    operations.push(...archive.edges.map((edge): NodeOperation => ({ type: "connect", edge: { ...edge, id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)! } })));
    // Validate every request and file before creating a room. UUID remapping does not change request sizes.
    const batches = archiveOperationBatches(operations, meta.maxSyncBytes);
    signal.throwIfAborted(); progress("正在创建导入画布…");
    const room = await collaborationApi<SharedRoom>("/rooms", { method: "POST", body: JSON.stringify({ title }) });
    onCreated(room);
    const fileIds = new Map<string, string>();
    for (const [index, asset] of archive.assets.entries()) {
        signal.throwIfAborted(); progress(`正在上传附件 ${index + 1}/${archive.assets.length}：${asset.name}`);
        const body = new FormData(); body.append("file", files.get(asset.id)!, archiveUploadName(asset));
        const stored = await collaborationApi<{ id: string; mime: string; size: number }>(`/rooms/${room.id}/files`, { method: "POST", body, signal });
        if (stored.mime !== asset.mime || stored.size !== asset.size) throw new Error(`附件「${asset.name}」上传结果不匹配`);
        fileIds.set(asset.id, stored.id);
    }
    for (const [index, batch] of batches.entries()) {
        signal.throwIfAborted(); progress(`正在还原节点和连线 ${index + 1}/${batches.length}…`);
        const restored = batch.map((operation) => operation.type === "create" && operation.node.fileId ? { ...operation, node: { ...operation.node, fileId: fileIds.get(operation.node.fileId)! } } : operation);
        await collaborationApi(`/rooms/${room.id}/operations`, { method: "POST", signal, body: JSON.stringify({ operationId: crypto.randomUUID(), operations: restored }) });
    }
    signal.throwIfAborted();
    return room;
}
