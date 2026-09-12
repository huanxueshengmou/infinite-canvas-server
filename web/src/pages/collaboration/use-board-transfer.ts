import { useEffect, useRef, useState, type RefObject } from "react";
import { App } from "antd";
import { collaborationApi, emptyPrivateData, type CollaborationMeta, type NodeOperation, type NodeTemplate, type SharedNode } from "@/services/api/collaboration";
import type { ViewportTransform } from "@/types/canvas";
import type { useCollaboration } from "./use-collaboration";

export type BoardPoint = { x: number; y: number };
type NewNode = Extract<NodeOperation, { type: "create" }>["node"];
const clipboardType = "application/x-infinite-canvas-nodes";
const operationBytes = (operations: NodeOperation[]) => new TextEncoder().encode(JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000000", operations })).length;
export const transferFiles = (data: DataTransfer) => data.files.length ? Array.from(data.files) : Array.from(data.items).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));

export function useBoardTransfer({ roomId, meta, sync, viewport, containerRef }: {
    roomId: string; meta: CollaborationMeta; sync: ReturnType<typeof useCollaboration>;
    viewport: ViewportTransform; containerRef: RefObject<HTMLDivElement | null>;
}) {
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const working = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const current = useRef({ sync, viewport });
    current.current = { sync, viewport };
    const canAdd = () => current.current.sync.canEdit && ["synced", "pending"].includes(current.current.sync.state);
    useEffect(() => () => { controller.current?.abort(); }, [roomId]);
    useEffect(() => { if (!canAdd()) controller.current?.abort(); }, [sync.state, sync.canEdit]);

    const run = async <T,>(action: () => Promise<T>): Promise<T> => {
        if (!canAdd()) throw new Error("请等待同步恢复，并确认你有画布编辑权限");
        if (working.current) throw new Error("文件或节点正在加入，请稍候");
        working.current = true; setBusy(true);
        try { return await action(); }
        finally { working.current = false; setBusy(false); }
    };
    const positionFor = (width: number, height: number, occupied: (NewNode | SharedNode)[], point?: BoardPoint) => {
        const rect = containerRef.current?.getBoundingClientRect(), view = current.current.viewport;
        const position = point ? { ...point } : { x: ((rect?.width || 800) / 2 - view.x) / view.k - width / 2, y: ((rect?.height || 600) / 2 - view.y) / view.k - height / 2 };
        // Reserve whole file batches as well as synchronized nodes, keeping the drop point when free.
        const rowStart = position.x;
        let rowBottom = position.y;
        for (let attempt = 0; attempt <= occupied.length; attempt++) {
            const collisions = occupied.filter((node) => position.x < node.position.x + node.width && position.x + width > node.position.x && position.y < node.position.y + node.height && position.y + height > node.position.y);
            if (!collisions.length) break;
            rowBottom = Math.max(rowBottom, ...collisions.map((node) => node.position.y + node.height));
            const nextX = Math.max(...collisions.map((node) => node.position.x + node.width)) + 32;
            if ((nextX + width) * view.k + view.x <= (rect?.width || 800) - 24) position.x = nextX;
            else { position.x = rowStart; position.y = rowBottom + 32; }
        }
        return position;
    };
    const makeNode = (kind: SharedNode["kind"], point?: BoardPoint, template?: NodeTemplate, fields?: Partial<NewNode>, reserved: NewNode[] = []): NewNode => {
        const width = ["image", "video", "markdown"].includes(kind) ? 360 : 320, height = kind === "markdown" ? 340 : ["image", "video"].includes(kind) ? 300 : 240;
        return {
            id: crypto.randomUUID(), kind, width, height,
            position: positionFor(width, height, [...current.current.sync.nodes, ...reserved], point),
            title: template?.name || (kind === "text" ? "新文本" : kind === "markdown" ? "Markdown" : ""),
            content: template?.kind === "custom" ? template.content : "", fileId: null,
            ...(kind === "private" ? { privateData: template?.privateData ? structuredClone(template.privateData) : emptyPrivateData() } : {}),
            ...(kind === "custom" ? { outputType: template?.outputType || "text" } : {}), ...fields,
        };
    };
    const create = (kind: SharedNode["kind"], point?: BoardPoint, template?: NodeTemplate) => run(async () => {
        const node = makeNode(kind, point, template);
        await current.current.sync.mutate([{ type: "create", node }]);
        return node;
    });
    const importFiles = (files: File[], point?: BoardPoint) => run(async () => {
        const abort = new AbortController(); controller.current = abort;
        const added: NewNode[] = [];
        try {
            const limits = await collaborationApi<CollaborationMeta>("/meta", { signal: abort.signal });
            for (const file of files) {
                if (abort.signal.aborted || !canAdd()) throw new Error("文件导入已停止，请在连接恢复后重新加入剩余文件");
                try {
                    if (file.size > limits.maxFileBytes) throw new Error(`单文件不能超过 ${limits.maxFileBytes / 1048576} MiB`);
                    let node: NewNode | undefined;
                    const markdown = /\.(md|markdown)$/i.test(file.name);
                    if (markdown && file.size <= limits.maxSyncBytes) {
                        const candidate = makeNode("markdown", point, undefined, { title: file.name, content: await file.text() }, added);
                        if (operationBytes([{ type: "create", node: candidate }]) <= limits.maxSyncBytes) node = candidate;
                    }
                    if (!node) {
                        const body = new FormData(); body.append("file", file);
                        const stored = await collaborationApi<{ id: string; mime: string }>(`/rooms/${roomId}/files`, { method: "POST", body, signal: abort.signal });
                        node = makeNode(stored.mime.startsWith("image/") ? "image" : stored.mime.startsWith("video/") ? "video" : "file", point, undefined, { title: file.name, fileId: stored.id }, added);
                    }
                    abort.signal.throwIfAborted();
                    added.push(node);
                    if (markdown && node.kind === "file") message.info(`${file.name} 超过当前单次同步上限，将作为下载附件加入`);
                } catch (error) {
                    if (abort.signal.aborted) throw error;
                    message.error(`${file.name}：${(error as Error).message}`);
                }
            }
            // Publish after uploading: collaborators' new media previews must not compete with this batch's uploads.
            let operations: NodeOperation[] = [];
            for (const node of added) {
                const operation: NodeOperation = { type: "create", node };
                if (operations.length && operationBytes([...operations, operation]) > limits.maxSyncBytes) {
                    abort.signal.throwIfAborted();
                    await current.current.sync.mutate(operations); operations = [];
                }
                operations.push(operation);
            }
            if (operations.length) { abort.signal.throwIfAborted(); await current.current.sync.mutate(operations); }
        } finally { if (controller.current === abort) controller.current = null; }
        return added.map((node) => node.id);
    });
    const copy = (event: ClipboardEvent, selected: Set<string>) => {
        const nodes = current.current.sync.nodes.filter((node) => selected.has(node.id) && node.kind !== "private");
        if (!nodes.length || !event.clipboardData) return;
        event.preventDefault();
        // Only public IDs cross the clipboard; private configuration is never serialized.
        event.clipboardData.setData(clipboardType, JSON.stringify({ roomId, ids: nodes.map((node) => node.id) }));
        event.clipboardData.setData("text/plain", nodes.map((node) => node.kind === "text" || node.kind === "markdown" ? node.content : node.title).join("\n"));
        message.success(`已复制 ${nodes.length} 个节点，可在当前画布粘贴`);
    };
    const paste = async (event: ClipboardEvent): Promise<string[] | null> => {
        if (!event.clipboardData) return null;
        const files = transferFiles(event.clipboardData);
        if (files.length) { event.preventDefault(); return importFiles(files); }
        const raw = event.clipboardData.getData(clipboardType);
        if (!raw) return null;
        event.preventDefault();
        const data = JSON.parse(raw);
        if (data?.roomId !== roomId || !Array.isArray(data.ids) || !data.ids.every((id: unknown) => typeof id === "string")) throw new Error("请在复制节点的原画布中粘贴，或直接加入原文件");
        return run(async () => {
            const sources = current.current.sync.nodes.filter((node) => data.ids.includes(node.id) && node.kind !== "private");
            if (!sources.length) throw new Error("复制的节点已不存在，请重新选择并复制");
            const left = Math.min(...sources.map((node) => node.position.x)), top = Math.min(...sources.map((node) => node.position.y));
            const width = Math.max(...sources.map((node) => node.position.x + node.width)) - left, height = Math.max(...sources.map((node) => node.position.y + node.height)) - top;
            const position = positionFor(width, height, current.current.sync.nodes);
            const operations: NodeOperation[] = sources.map((node) => ({ type: "create", node: {
                id: crypto.randomUUID(), kind: node.kind, width: node.width, height: node.height,
                position: { x: position.x + node.position.x - left, y: position.y + node.position.y - top },
                title: node.title, content: node.content, fileId: node.fileId,
                ...(node.kind === "custom" ? { outputType: node.outputType || "text" } : {}),
            } }));
            if (operationBytes(operations) > meta.maxSyncBytes) throw new Error("复制的内容超过当前单次同步上限，请减少所选节点后粘贴");
            await current.current.sync.mutate(operations);
            return operations.map((operation) => operation.type === "create" ? operation.node.id : "");
        });
    };
    return { busy, create, importFiles, copy, paste };
}
