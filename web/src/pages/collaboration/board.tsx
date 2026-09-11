import { useCallback, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Alert, App, Button, Input, Modal, Space, Tooltip } from "antd";
import { ArrowLeft, FileUp, LockKeyhole, Plus, RefreshCw, Share2, Trash2, Users } from "lucide-react";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { collaborationApi, collaborationFileUrl, emptyPrivateData, type CollaborationMeta, type SharedNode } from "@/services/api/collaboration";
import type { ViewportTransform } from "@/types/canvas";
import { useCollaboration } from "./use-collaboration";
import { PrivateDialog } from "./private-dialog";
import { ShareDialog } from "./share-dialog";

const syncLabels = { connecting: "连接中", synced: "已同步", pending: "后台同步中", offline: "离线 · 草稿仅在当前页", denied: "需要重新验证权限", conflict: "有编辑冲突" };

export function CollaborationBoard({ roomId, meta, onBack }: { roomId: string; meta: CollaborationMeta; onBack: () => void }) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [privateId, setPrivateId] = useState<string | null>(null);
    const [shareOpen, setShareOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 100, y: 130, k: 1 });
    const closePrivate = useCallback(() => { setPrivateId(null); setShareOpen(false); }, []);
    const sync = useCollaboration(roomId, meta, closePrivate);
    const containerRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ id: string; x: number; y: number; position: SharedNode["position"] } | null>(null);

    const create = async (kind: SharedNode["kind"], file?: { id: string; title: string }) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = kind === "image" ? 360 : 300;
        const height = kind === "image" ? 300 : 220;
        const position = { x: ((rect?.width || 800) / 2 - viewport.x) / viewport.k - width / 2, y: ((rect?.height || 600) / 2 - viewport.y) / viewport.k - height / 2 };
        // Find an empty slot so a private placeholder cannot cover another person's text.
        for (let attempt = 0; attempt <= sync.nodes.length; attempt++) {
            if (!sync.nodes.some((node) => position.x < node.position.x + node.width && position.x + width > node.position.x && position.y < node.position.y + node.height && position.y + height > node.position.y)) break;
            position.x += width + 32;
            if ((position.x + width) * viewport.k + viewport.x > (rect?.width || 800) - 24) { position.x = (24 - viewport.x) / viewport.k; position.y += height + 32; }
        }
        const node = {
            id: crypto.randomUUID(), kind,
            position, width, height,
            title: file?.title || (kind === "text" ? "新文本" : ""), content: "", fileId: file?.id || null,
            ...(kind === "private" ? { privateData: emptyPrivateData() } : {}),
        };
        setBusy(true);
        try { await sync.mutate([{ type: "create", node }]); if (kind === "private") setPrivateId(node.id); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const upload = async (file?: File) => {
        if (!file) return;
        if (file.size > meta.maxFileBytes) { message.error(`单文件不能超过 ${meta.maxFileBytes / 1024 / 1024} MiB`); return; }
        setBusy(true);
        try {
            const body = new FormData(); body.append("file", file);
            const stored = await collaborationApi<{ id: string; mime: string }>(`/rooms/${roomId}/files`, { method: "POST", body });
            await create(stored.mime.startsWith("image/") ? "image" : "file", { id: stored.id, title: file.name });
        } catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
    };
    const remove = (node: SharedNode) => modal.confirm({
        title: node.kind === "private" ? "删除这个隐私节点及私有内容？" : "从协作画布中删除节点？",
        onOk: async () => { try { await sync.mutate([{ type: "delete", id: node.id, version: node.version }]); } catch (error) { message.error((error as Error).message); throw error; } },
    });
    const startDrag = (event: PointerEvent<HTMLDivElement>, node: SharedNode) => {
        if (event.button !== 0 || !sync.canEdit || (node.kind === "private" && !sync.ownPrivateIds.has(node.id))) return;
        if ((event.target as Element).closest("button,input,textarea")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: node.id, x: event.clientX, y: event.clientY, position: node.position };
    };
    const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current) return;
        sync.edit(current.id, { position: { x: current.position.x + (event.clientX - current.x) / viewport.k, y: current.position.y + (event.clientY - current.y) / viewport.k } });
    };
    const back = () => {
        if (["pending", "offline", "conflict"].includes(sync.state)) modal.confirm({ title: "离开协作画布？", content: "尚未同步的草稿只保存在当前页面，离开后无法恢复。", onOk: onBack });
        else onBack();
    };

    return (
        <div className="relative h-dvh overflow-hidden" style={{ color: theme.node.text, background: theme.canvas.background }}>
            <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" onViewportChange={setViewport}>
                {sync.nodes.map((node) => {
                    const own = sync.ownPrivateIds.has(node.id);
                    const editable = sync.canEdit && (node.kind !== "private" || own);
                    return <div key={node.id} data-node-id={node.id} className="absolute flex flex-col overflow-hidden rounded-xl border" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, background: theme.node.panel, borderColor: theme.node.stroke }}>
                        <div className="flex min-h-11 shrink-0 cursor-move items-center justify-between gap-2 px-3" onPointerDown={(event) => startDrag(event, node)} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.kind === "private" ? "隐私节点" : node.title || "未命名节点"}</span>
                            {editable && <Tooltip title="删除节点"><Button type="text" size="small" aria-label="删除节点" icon={<Trash2 className="size-3.5" />} onClick={() => remove(node)} /></Tooltip>}
                        </div>
                        {node.kind === "private" ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-sm" style={{ color: theme.node.muted }}>
                            <LockKeyhole className="size-7" /><span>内容仅创建者可见</span>
                            {own && <Button type="text" disabled={["offline", "denied", "connecting"].includes(sync.state)} onClick={() => setPrivateId(node.id)}>打开我的隐私内容</Button>}
                        </div> : node.kind === "text" ? <div data-canvas-no-zoom className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
                            <Input aria-label="节点标题" variant="borderless" value={node.title} readOnly={!editable} onChange={(event) => sync.edit(node.id, { title: event.target.value })} />
                            <Input.TextArea aria-label="协作文本" variant="borderless" className="!flex-1 !resize-none" value={node.content} readOnly={!editable} placeholder="写下内容，协作者会实时看到…" onChange={(event) => sync.edit(node.id, { content: event.target.value })} />
                        </div> : node.kind === "image" && node.fileId ? <img className="min-h-0 w-full flex-1 object-contain p-3" src={collaborationFileUrl(roomId, node.fileId)} alt={node.title} draggable={false} /> : <div className="flex flex-1 items-center justify-center p-4">{node.fileId && <a className="underline" href={collaborationFileUrl(roomId, node.fileId)} download>{node.title || "下载附件"}</a>}</div>}
                    </div>;
                })}
            </InfiniteCanvas>
            <header className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-3 p-4" style={{ color: theme.node.text }}>
                <div className="pointer-events-auto flex min-w-0 items-center gap-3">
                    <Button type="text" aria-label="返回协作空间" icon={<ArrowLeft className="size-4" />} onClick={back} />
                    <strong className="max-w-64 truncate">{sync.room?.title || "协作画布"}</strong>
                    <span className="text-xs opacity-65" role="status">{syncLabels[sync.state]}{sync.room?.role === "viewer" ? " · 只读" : ""}</span>
                </div>
                <Space className="pointer-events-auto" wrap>
                    <span className="mr-2 inline-flex items-center gap-1 text-sm"><Users className="size-4" />{sync.online} 人在线</span>
                    <Button type="text" icon={<RefreshCw className="size-4" />} onClick={sync.reconnect}>重新连接</Button>
                    {sync.room?.role === "owner" && <Button type="text" icon={<Share2 className="size-4" />} onClick={() => setShareOpen(true)}>分享与权限</Button>}
                </Space>
            </header>
            {sync.error && <div className="absolute left-4 right-4 top-20 z-10"><Alert type={sync.state === "denied" ? "error" : "warning"} title={sync.error} /></div>}
            <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2" style={{ color: theme.node.text }}>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<Plus className="size-4" />} onClick={() => void create("text")}>协作文本</Button>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>共享图片 / 文件</Button>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<LockKeyhole className="size-4" />} onClick={() => void create("private")}>隐私节点</Button>
                <span className="ml-3 text-xs opacity-60">{Math.round(viewport.k * 100)}%</span>
            </div>
            <input ref={fileRef} type="file" className="hidden" aria-label="上传共享文件" onChange={(event) => void upload(event.target.files?.[0])} />
            {privateId && <PrivateDialog roomId={roomId} nodeId={privateId} onClose={closePrivate} canEdit={sync.canEdit} />}
            {shareOpen && sync.room && <ShareDialog room={sync.room} onClose={() => setShareOpen(false)} shareTtlMs={meta.shareTtlMs} />}
            <Modal open={sync.conflicts.length > 0} title="编辑冲突 · 你的草稿已保留" footer={null} closable={false} maskClosable={false}>
                <p className="mb-4 text-sm opacity-70">其他协作者已经修改了同一个节点。请选择使用服务器内容，或确认把你的草稿应用到最新版本。</p>
                {sync.conflicts.map((id) => {
                    const draft = sync.getDraft(id);
                    return <div key={id} className="mb-4 border-t border-current/15 pt-3"><p className="font-medium">{draft?.base.title || "节点"}</p><pre className="my-2 max-h-40 select-text overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(draft?.fields, null, 2)}</pre><Space><Button onClick={() => sync.resolveConflict(id, false)}>使用服务器内容</Button><Button disabled={!sync.nodes.some((node) => node.id === id)} onClick={() => sync.resolveConflict(id, true)}>确认应用我的草稿</Button></Space></div>;
                })}
            </Modal>
        </div>
    );
}
