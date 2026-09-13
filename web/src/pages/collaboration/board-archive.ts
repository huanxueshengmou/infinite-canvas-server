import { z } from "zod";
import type { SharedEdge, SharedNode } from "@/services/api/collaboration";

export const ARCHIVE_ELEMENT_ID = "infinite-canvas-archive";
export const ARCHIVE_FILE_PREFIX = "canvas-file-";
const id = z.string().uuid();
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const ink = { color: z.union([z.string().regex(/^#[0-9a-f]{6}$/i), z.literal("currentColor")]), size: z.number().positive().finite() };
const drawing = z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("brush"), points: z.array(point).min(1), ...ink }).strict(),
    z.object({ type: z.literal("arrow"), from: point, to: point, ...ink }).strict(),
    z.object({ type: z.literal("text"), position: point, text: z.string(), ...ink }).strict(),
]));
const nodeSchema = z.object({
    id, kind: z.enum(["text", "markdown", "image", "video", "file", "custom", "private", "group", "whiteboard"]),
    position: point, width: z.number().positive().finite(), height: z.number().positive().finite(),
    title: z.string(), content: z.string(), fileId: id.nullable(),
    outputType: z.enum(["text", "json"]).optional(), groupId: id.nullable().optional(), drawing: drawing.optional(),
}).strict();
const edgeSchema = z.object({ id, source: id, sourcePort: z.literal("output"), target: id, targetPort: z.enum(["input", "image", "audio"]) }).strict();
const mimeExtensions = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav",
    "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/flac": ".flac", "application/octet-stream": ".bin",
} as const;
const archiveSchema = z.object({
    app: z.literal("infinite-canvas-collaboration"), version: z.literal(1), title: z.string().trim().min(1),
    exportedAt: z.string().datetime(), nodes: z.array(nodeSchema), edges: z.array(edgeSchema),
    assets: z.array(z.object({ id, name: z.string().min(1), mime: z.enum(Object.keys(mimeExtensions) as [keyof typeof mimeExtensions, ...Array<keyof typeof mimeExtensions>]), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict();
export type BoardArchive = z.infer<typeof archiveSchema>;
export type ArchiveNode = BoardArchive["nodes"][number];
export type ArchiveAsset = BoardArchive["assets"][number];
export type PreparedArchive = { archive: BoardArchive; files: Map<string, Blob> };
export type ArchiveProgress = (text: string) => void;
export const safeArchiveName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim() || "协作画布";
export const archiveUploadName = (asset: ArchiveAsset) => `${asset.id}${mimeExtensions[asset.mime]}`;

// Explicitly project public fields. Never serialize sessions, private records, or plugin metadata.
export function archiveNodes(nodes: SharedNode[]): ArchiveNode[] {
    return nodes.map((node) => ({
        id: node.id, kind: node.kind, position: { ...node.position }, width: node.width, height: node.height,
        title: node.kind === "private" ? "隐私节点" : node.title, content: node.kind === "private" ? "" : node.content, fileId: node.kind === "private" ? null : node.fileId,
        ...(node.kind === "custom" ? { outputType: node.outputType || "text" } : {}),
        ...(node.kind !== "private" && node.groupId ? { groupId: node.groupId } : {}),
        ...(node.kind === "whiteboard" ? { drawing: structuredClone(node.drawing || []) } : {}),
    }));
}
export const archiveEdges = (edges: SharedEdge[]) => edges.map(({ id, source, sourcePort, target, targetPort }) => ({ id, source, sourcePort, target, targetPort }));

export function validateArchive(value: unknown): BoardArchive {
    if (typeof value === "object" && value && "version" in value && value.version !== 1) throw new Error("不支持这个画布文件的版本，请使用支持该版本的协作画布导入");
    const result = archiveSchema.safeParse(value);
    if (!result.success) throw new Error("画布数据格式不正确或文件不完整，请重新导出 HTML");
    const archive = result.data;
    const nodes = new Map(archive.nodes.map((node) => [node.id, node])), assets = new Map(archive.assets.map((asset) => [asset.id, asset]));
    if (nodes.size !== archive.nodes.length || assets.size !== archive.assets.length || new Set(archive.edges.map((edge) => edge.id)).size !== archive.edges.length) throw new Error("画布文件包含重复的节点、连线或附件标识");
    const usedFiles = new Set<string>();
    for (const node of archive.nodes) {
        if (node.kind === "private" && (node.title !== "隐私节点" || node.content || node.fileId || node.groupId || node.drawing)) throw new Error("隐私节点只能以空白占位导入");
        if (node.outputType && node.kind !== "custom" || node.drawing && node.kind !== "whiteboard") throw new Error("节点包含不适用的配置");
        if (["group", "whiteboard"].includes(node.kind) && node.fileId) throw new Error("分组和白板不能包含文件引用");
        if (node.groupId && (["group", "private"].includes(node.kind) || nodes.get(node.groupId)?.kind !== "group")) throw new Error("画布分组关系不完整或包含嵌套分组");
        if (node.fileId) {
            const asset = assets.get(node.fileId);
            if (!asset) throw new Error(`节点「${node.title}」缺少附件`);
            if (node.kind === "image" && !asset.mime.startsWith("image/") || node.kind === "video" && !asset.mime.startsWith("video/")) throw new Error(`节点「${node.title}」的附件类型不匹配`);
            usedFiles.add(node.fileId);
        }
    }
    if (usedFiles.size !== assets.size) throw new Error("画布文件包含未被节点引用的附件");
    const slots = new Set<string>(), successors = new Map<string, string[]>(), indegree = new Map<string, number>();
    for (const edge of archive.edges) {
        const source = nodes.get(edge.source), target = nodes.get(edge.target);
        if (!source || !target || ["group", "whiteboard"].includes(source.kind) || !["custom", "private"].includes(target.kind)) throw new Error("画布连线的节点或端口不正确");
        if (source.kind === "private" && target.kind !== "private") throw new Error("隐私输出不能连接公开节点");
        if (edge.targetPort === "image" && !["image", "private"].includes(source.kind)) throw new Error("图片输入的连线不正确");
        if (edge.targetPort === "audio" && source.kind !== "private" && (source.kind !== "file" || !source.fileId || !assets.get(source.fileId)?.mime.startsWith("audio/"))) throw new Error("音频输入的连线不正确");
        const slot = `${edge.target}:${edge.targetPort}`;
        if (slots.has(slot)) throw new Error("同一输入端口存在多条连线");
        slots.add(slot);
        successors.set(edge.source, [...(successors.get(edge.source) || []), edge.target]);
        if (!indegree.has(edge.source)) indegree.set(edge.source, 0);
        indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    }
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) for (const next of successors.get(queue[index]) || []) {
        indegree.set(next, indegree.get(next)! - 1);
        if (!indegree.get(next)) queue.push(next);
    }
    if (queue.length !== indegree.size) throw new Error("画布连线不能形成循环");
    return archive;
}

export async function sha256(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Blob(base64: string, mime: string) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < base64.length; offset += 65536) {
        const bytes = atob(base64.slice(offset, offset + 65536));
        parts.push(Uint8Array.from(bytes, (character) => character.charCodeAt(0)));
    }
    return new Blob(parts, { type: mime });
}

export async function readBoardArchive(file: File, signal: AbortSignal, progress: ArchiveProgress): Promise<PreparedArchive> {
    progress("正在读取画布文件…");
    // Template contents are inert: unlike a live document, imported scripts and resource URLs never run/load.
    const template = document.createElement("template");
    template.innerHTML = await file.text();
    signal.throwIfAborted();
    const manifests = template.content.querySelectorAll(`script[id="${ARCHIVE_ELEMENT_ID}"][type="application/json"]`);
    if (manifests.length !== 1) throw new Error("请选择由本应用导出的画布 HTML；普通网页无法还原为画布");
    let data: unknown;
    try { data = JSON.parse(manifests[0].textContent || ""); } catch { throw new Error("画布数据已损坏，请重新导出 HTML"); }
    const archive = validateArchive(data), files = new Map<string, Blob>();
    for (const [index, asset] of archive.assets.entries()) {
        progress(`正在校验附件 ${index + 1}/${archive.assets.length}：${asset.name}`);
        signal.throwIfAborted();
        const elements = template.content.querySelectorAll(`script[id="${ARCHIVE_FILE_PREFIX}${asset.id}"][type="application/octet-stream"]`);
        if (elements.length !== 1) throw new Error(`附件「${asset.name}」缺失或重复`);
        const base64 = (elements[0].textContent || "").trim();
        if (base64.length !== Math.ceil(asset.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error(`附件「${asset.name}」的编码不完整`);
        let blob: Blob;
        try { blob = base64Blob(base64, asset.mime); } catch { throw new Error(`附件「${asset.name}」无法解码`); }
        if (blob.size !== asset.size || await sha256(blob) !== asset.sha256) throw new Error(`附件「${asset.name}」完整性校验失败，请重新导出`);
        signal.throwIfAborted();
        files.set(asset.id, blob);
    }
    return { archive, files };
}
