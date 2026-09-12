import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Alert, App, Button, Input, Modal, Space, Tooltip } from "antd";
import { ArrowLeft, FileUp, LockKeyhole, Plus, RefreshCw, Share2, Trash2, Users, Workflow, Unplug, Cable, Undo2, Redo2 } from "lucide-react";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { collaborationApi, collaborationFileUrl, emptyPrivateData, type CollaborationMeta, type SharedNode, type NodeTemplate, type InputPort, type SharedEdge } from "@/services/api/collaboration";
import type { ViewportTransform } from "@/types/canvas";
import { useCollaboration } from "./use-collaboration";
import { PrivateDialog } from "./private-dialog";
import { ShareDialog } from "./share-dialog";
import { TemplatesDialog } from "./templates-dialog";
import { CustomDialog } from "./custom-dialog";

const syncLabels = { connecting: "连接中", synced: "已同步", pending: "后台同步中", offline: "离线 · 草稿仅在当前页", denied: "需要重新验证权限", conflict: "有编辑冲突" };
const inputPorts: { id: InputPort; label: string; offset: number }[] = [{ id: "input", label: "文本 / JSON 输入", offset: 70 }, { id: "image", label: "图片输入", offset: 112 }, { id: "audio", label: "音频输入", offset: 154 }];
type Point = { x: number; y: number };
type Wire = { source: string; edge?: SharedEdge; point: Point; hover?: string };
type Selection = { start: Point; end: Point; base: Set<string>; pointerId: number };
const isInput = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable='true'],[role='textbox']"));
const curve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const bend = Math.max(Math.abs(to.x - from.x) * 0.5, 50);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};

export function CollaborationBoard({ roomId, meta, onBack }: { roomId: string; meta: CollaborationMeta; onBack: () => void }) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [privateId, setPrivateId] = useState<string | null>(null);
    const [shareOpen, setShareOpen] = useState(false);
    const [templatesOpen, setTemplatesOpen] = useState(false);
    const [customId, setCustomId] = useState<string | null>(null);
    const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
    const [wiring, setWiring] = useState<Wire | null>(null);
    const [portChoice, setPortChoice] = useState<{ wire: Wire; target: string; ports: typeof inputPorts } | null>(null);
    const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
    const [selection, setSelection] = useState<Selection | null>(null);
    const [busy, setBusy] = useState(false);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 100, y: 130, k: 1 });
    const closePrivate = useCallback(() => { setPrivateId(null); setShareOpen(false); setTemplatesOpen(false); setCustomId(null); setWiring(null); setPortChoice(null); }, []);
    const closeTemplates = useCallback(() => setTemplatesOpen(false), []);
    const sync = useCollaboration(roomId, meta, closePrivate);
    const containerRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const drag = useRef<{ x: number; y: number; pointerId: number; nodes: { id: string; position: Point }[] } | null>(null);
    const reportError = (error: unknown) => { message.error((error as Error).message); };
    const worldPoint = (event: { clientX: number; clientY: number }) => {
        const rect = containerRef.current?.getBoundingClientRect();
        return { x: (event.clientX - (rect?.left || 0) - viewport.x) / viewport.k, y: (event.clientY - (rect?.top || 0) - viewport.y) / viewport.k };
    };
    const connectTo = async (target: string, targetPort: InputPort, wire = wiring) => {
        if (!wire) return;
        setWiring(null); setPortChoice(null);
        if (wire.edge?.target === target && wire.edge.targetPort === targetPort) return;
        try { await sync.mutate([{ type: "connect", edge: { id: wire.edge?.id || crypto.randomUUID(), source: wire.source, sourcePort: "output", target, targetPort }, ...(wire.edge ? { version: wire.edge.version } : {}) }]); }
        catch (error) { reportError(error); }
    };
    const availableNode = (node: SharedNode) => node.kind !== "private" || sync.ownPrivateIds.has(node.id);
    const connectNode = (targetId: string, wire: Wire) => {
        const source = sync.nodes.find((node) => node.id === wire.source), target = sync.nodes.find((node) => node.id === targetId);
        if (!source || !target || source.id === target.id) return;
        if (!["custom", "private"].includes(target.kind) || !availableNode(target)) { setWiring(null); message.warning("请连接到自定义节点或自己的隐私节点"); return; }
        if (source.kind === "private" && target.kind !== "private") { setWiring(null); message.warning("隐私输出只能连接到自己的隐私节点"); return; }
        if (source.kind !== "private" && source.kind !== "file") { void connectTo(targetId, source.kind === "image" ? "image" : "input", wire); return; }
        const ports = inputPorts.filter((port) => (source.kind === "private" || port.id !== "image") && !sync.edges.some((edge) => edge.id !== wire.edge?.id && edge.target === targetId && edge.targetPort === port.id));
        setWiring(null);
        if (ports.length === 1) void connectTo(targetId, ports[0].id, wire);
        else if (ports.length) setPortChoice({ wire, target: targetId, ports });
        else message.warning("这个节点的可用输入已有连线，请先断开或重连");
    };
    const disconnect = async (edge: SharedEdge) => {
        try { await sync.mutate([{ type: "disconnect", id: edge.id, version: edge.version }]); setSelectedEdge(null); }
        catch (error) { reportError(error); }
    };

    const create = async (kind: SharedNode["kind"], file?: { id: string; title: string }, template?: NodeTemplate) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const width = ["image", "video"].includes(kind) ? 360 : 320;
        const height = ["image", "video"].includes(kind) ? 300 : 240;
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
            title: file?.title || template?.name || (kind === "text" ? "新文本" : ""), content: template?.kind === "custom" ? template.content : "", fileId: file?.id || null,
            ...(kind === "private" ? { privateData: template?.privateData ? structuredClone(template.privateData) : emptyPrivateData() } : {}),
            ...(kind === "custom" ? { outputType: template?.outputType || "text" as const } : {}),
        };
        setBusy(true);
        try { await sync.mutate([{ type: "create", node }]); if (kind === "private") setPrivateId(node.id); if (kind === "custom") setCustomId(node.id); }
        finally { setBusy(false); }
    };
    const upload = async (file?: File) => {
        if (!file) return;
        setBusy(true);
        try {
            const limits = await collaborationApi<CollaborationMeta>("/meta");
            if (file.size > limits.maxFileBytes) { message.error(`单文件不能超过 ${limits.maxFileBytes / 1048576} MiB`); return; }
            const body = new FormData(); body.append("file", file);
            const stored = await collaborationApi<{ id: string; mime: string }>(`/rooms/${roomId}/files`, { method: "POST", body });
            await create(stored.mime.startsWith("image/") ? "image" : stored.mime.startsWith("video/") ? "video" : "file", { id: stored.id, title: file.name });
        } catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
    };
    const remove = (nodes: SharedNode[]) => modal.confirm({
        title: `从协作画布中删除${nodes.length > 1 ? `选中的 ${nodes.length} 个` : "这个"}节点？`,
        content: "关联连线也会删除，可在当前页面通过撤销恢复。",
        onOk: async () => { try { await sync.mutate(nodes.map((node) => ({ type: "delete" as const, id: node.id, version: node.version }))); setSelectedNodes(new Set()); } catch (error) { message.error((error as Error).message); throw error; } },
    });
    const startDrag = (event: PointerEvent<HTMLDivElement>, node: SharedNode) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || wiring || !sync.canEdit || !availableNode(node)) return;
        if ((event.target as Element).closest("button,input,textarea")) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const ids = selectedNodes.has(node.id) ? selectedNodes : new Set([node.id]);
        setSelectedNodes(ids); setSelectedEdge(null); sync.beginEditing();
        drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, nodes: sync.nodes.filter((item) => ids.has(item.id) && availableNode(item)).map(({ id, position }) => ({ id, position })) };
    };
    const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const dx = (event.clientX - current.x) / viewport.k, dy = (event.clientY - current.y) / viewport.k;
        if (dx || dy) sync.editMany(current.nodes.map(({ id, position }) => ({ id, fields: { position: { x: position.x + dx, y: position.y + dy } } })));
    };
    const endDrag = () => { if (drag.current) { drag.current = null; sync.endEditing(); } };
    const startSelection = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !containerRef.current?.contains(event.target as Node)) return;
        if ((event.target as Element).closest("[data-node-id],[data-connection-id]")) return;
        event.preventDefault(); event.stopPropagation();
        containerRef.current.setPointerCapture(event.pointerId);
        const start = worldPoint(event), base = event.shiftKey ? new Set(selectedNodes) : new Set<string>();
        setSelection({ start, end: start, base, pointerId: event.pointerId }); setSelectedNodes(base); setSelectedEdge(null); setWiring(null);
    };
    const back = () => {
        if (["pending", "offline", "conflict"].includes(sync.state)) modal.confirm({ title: "离开协作画布？", content: "尚未同步的草稿只保存在当前页面，离开后无法恢复。", onOk: onBack });
        else onBack();
    };
    const chosenEdge = sync.edges.find((edge) => edge.id === selectedEdge);
    const edgeEditable = chosenEdge && sync.canEdit && [chosenEdge.source, chosenEdge.target].every((id) => sync.nodes.find((node) => node.id === id)?.kind !== "private" || sync.ownPrivateIds.has(id));
    const customNode = sync.nodes.find((node) => node.id === customId);
    const selected = sync.nodes.filter((node) => selectedNodes.has(node.id) && availableNode(node));
    useEffect(() => {
        const keyboard = (event: KeyboardEvent) => {
            if (isInput(event.target) || document.querySelector(".ant-modal-wrap:not([style*='display: none'])") || privateId || customId || templatesOpen || shareOpen || portChoice || busy) return;
            if (event.key === "Escape") { setWiring(null); setSelectedEdge(null); setSelectedNodes(new Set()); setSelection(null); return; }
            const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
            if (command && !event.altKey && (key === "z" || key === "y")) {
                event.preventDefault();
                if (sync.canEdit) void sync.changeHistory(key === "y" || event.shiftKey ? "redo" : "undo").catch(reportError);
            } else if (command && key === "a") { event.preventDefault(); setSelectedNodes(new Set(sync.nodes.filter(availableNode).map((node) => node.id))); }
            else if ((key === "delete" || key === "backspace") && sync.canEdit) {
                if (selected.length) { event.preventDefault(); remove(selected); }
                else if (edgeEditable && chosenEdge) { event.preventDefault(); void disconnect(chosenEdge); }
            }
        };
        window.addEventListener("keydown", keyboard);
        return () => window.removeEventListener("keydown", keyboard);
    });

    return (
        <div className="relative h-dvh overflow-hidden" style={{ color: theme.node.text, background: theme.canvas.background }} onPointerDownCapture={startSelection} onPointerMove={(event) => {
            const container = containerRef.current;
            if (!container?.contains(event.target as Node)) { sync.setCursor(null); return; }
            const point = worldPoint(event);
            sync.setCursor({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
            if (wiring) setWiring({ ...wiring, point, hover: document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId });
            if (selection && selection.pointerId === event.pointerId) {
                const left = Math.min(selection.start.x, point.x), top = Math.min(selection.start.y, point.y), right = Math.max(selection.start.x, point.x), bottom = Math.max(selection.start.y, point.y);
                setSelection({ ...selection, end: point });
                setSelectedNodes(new Set([...selection.base, ...sync.nodes.filter((node) => availableNode(node) && node.position.x <= right && node.position.x + node.width >= left && node.position.y <= bottom && node.position.y + node.height >= top).map((node) => node.id)]));
            }
        }} onPointerUp={(event) => {
            setSelection(null); endDrag();
            if (!wiring) return;
            const element = document.elementFromPoint(event.clientX, event.clientY);
            const input = element?.closest<HTMLElement>("[data-input-port]");
            if (input?.dataset.targetId && input.dataset.inputPort) void connectTo(input.dataset.targetId, input.dataset.inputPort as InputPort);
            else { const target = element?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId; if (target) connectNode(target, wiring); }
        }} onPointerCancel={() => { setWiring(null); setSelection(null); endDrag(); }} onPointerLeave={() => sync.setCursor(null)}>
            <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" onViewportChange={setViewport} onCanvasDeselect={() => { setSelectedEdge(null); setWiring(null); setSelectedNodes(new Set()); }}>
                <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-label="节点连线">
                    {sync.edges.map((edge) => {
                        const source = sync.nodes.find((node) => node.id === edge.source), target = sync.nodes.find((node) => node.id === edge.target);
                        if (!source || !target) return null;
                        const path = curve({ x: source.position.x + source.width, y: source.position.y + source.height / 2 }, { x: target.position.x, y: target.position.y + inputPorts.find((port) => port.id === edge.targetPort)!.offset });
                        return <g key={edge.id}>
                            <path data-connection-id={edge.id} d={path} fill="none" stroke="transparent" strokeWidth={16 / viewport.k} style={{ pointerEvents: "stroke", cursor: "pointer" }} onClick={(event) => { event.stopPropagation(); setSelectedEdge(edge.id); setSelectedNodes(new Set()); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (sync.canEdit && availableNode(source) && availableNode(target)) void disconnect(edge); }} />
                            <path d={path} fill="none" stroke={selectedEdge === edge.id ? theme.node.activeStroke : theme.node.muted} strokeWidth={(selectedEdge === edge.id ? 3 : 2) / viewport.k} />
                        </g>;
                    })}
                    {wiring && (() => { const source = sync.nodes.find((node) => node.id === wiring.source); return source ? <path d={curve({ x: source.position.x + source.width, y: source.position.y + source.height / 2 }, wiring.point)} fill="none" stroke={theme.node.activeStroke} strokeWidth={2 / viewport.k} strokeDasharray="5 5" /> : null; })()}
                </svg>
                {sync.nodes.map((node) => {
                    const own = sync.ownPrivateIds.has(node.id);
                    const editable = sync.canEdit && (node.kind !== "private" || own);
                    const highlighted = selectedNodes.has(node.id) || (wiring?.hover === node.id && wiring.source !== node.id);
                    return <div key={node.id} data-node-id={node.id} data-selected={selectedNodes.has(node.id) || undefined} className="absolute flex flex-col rounded-xl border" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, background: theme.node.panel, borderColor: highlighted ? theme.node.activeStroke : theme.node.stroke, outline: highlighted ? `1px solid ${theme.node.activeStroke}` : undefined }} onPointerDownCapture={(event) => {
                        if (event.button !== 0 || wiring || !availableNode(node) || (event.target as Element).closest("button,input,textarea,a,video,[contenteditable='true']")) return;
                        if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); setSelectedNodes((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; }); setSelectedEdge(null); }
                        else if (!selectedNodes.has(node.id)) { setSelectedNodes(new Set([node.id])); setSelectedEdge(null); }
                    }}>
                        {(node.kind !== "private" || own) && <>
                            <Tooltip open={wiring ? false : undefined} styles={{ root: { pointerEvents: "none" } }} title="输出：拖到下游节点即可连接，也可指定输入端口"><button type="button" data-output-port={node.id} aria-label={`${node.kind === "private" ? "隐私节点" : node.title} 输出端口`} disabled={!editable} className="absolute -right-2 top-1/2 z-10 size-4 -translate-y-1/2 cursor-crosshair rounded-full border-2" style={{ background: theme.node.panel, borderColor: theme.node.activeStroke }} onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setWiring({ source: node.id, point: worldPoint(event) }); setSelectedEdge(null); }} onClick={(event) => { if (event.detail === 0) setWiring({ source: node.id, point: { x: node.position.x + node.width, y: node.position.y + node.height / 2 } }); }} /></Tooltip>
                            {["custom", "private"].includes(node.kind) && inputPorts.map((port) => <Tooltip key={port.id} open={wiring ? false : undefined} styles={{ root: { pointerEvents: "none" } }} title={port.label}><button type="button" data-input-port={port.id} data-target-id={node.id} aria-label={`${node.kind === "private" ? "隐私节点" : node.title} ${port.label}`} disabled={!editable} className="absolute -left-2 z-10 size-4 -translate-y-1/2 cursor-crosshair rounded-full border-2" style={{ top: port.offset, background: theme.node.panel, borderColor: theme.node.activeStroke }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { if (event.detail === 0) void connectTo(node.id, port.id); }} /></Tooltip>)}
                        </>}
                        <div className="flex min-h-11 shrink-0 cursor-move items-center justify-between gap-2 px-3" style={{ touchAction: "none" }} onPointerDown={(event) => startDrag(event, node)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.kind === "private" ? "隐私节点" : node.title || "未命名节点"}</span>
                            {editable && <Tooltip title="删除节点"><Button type="text" size="small" aria-label="删除节点" icon={<Trash2 className="size-3.5" />} onClick={() => remove([node])} /></Tooltip>}
                        </div>
                        {node.kind === "private" ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-sm" style={{ color: theme.node.muted }}>
                            <LockKeyhole className="size-7" /><span>内容仅创建者可见</span>
                            {own && <Button type="text" disabled={["offline", "denied", "connecting"].includes(sync.state)} onClick={() => setPrivateId(node.id)}>打开我的隐私内容</Button>}
                        </div> : node.kind === "custom" ? <div className="flex min-h-0 flex-1 flex-col gap-3 p-4"><span className="text-xs opacity-60">自定义 · {node.outputType === "json" ? "JSON 数据" : "文本拼接"}</span><pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-all text-xs opacity-70">{node.content}</pre><Button type="text" onClick={() => setCustomId(node.id)}>配置 / 计算输出</Button></div> : node.kind === "text" ? <div data-canvas-no-zoom className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
                            <Input aria-label="节点标题" variant="borderless" value={node.title} readOnly={!editable} onFocus={sync.beginEditing} onBlur={sync.endEditing} onChange={(event) => sync.edit(node.id, { title: event.target.value })} />
                            <Input.TextArea aria-label="协作文本" variant="borderless" className="!flex-1 !resize-none" value={node.content} readOnly={!editable} placeholder="写下内容，协作者会实时看到…" onFocus={sync.beginEditing} onBlur={sync.endEditing} onChange={(event) => sync.edit(node.id, { content: event.target.value })} />
                        </div> : node.kind === "image" && node.fileId ? <img className="min-h-0 w-full flex-1 object-contain p-3" src={collaborationFileUrl(roomId, node.fileId)} alt={node.title} draggable={false} /> : node.kind === "video" && node.fileId ? <video data-canvas-no-zoom className="min-h-0 w-full flex-1 object-contain p-3" controls preload="metadata" src={collaborationFileUrl(roomId, node.fileId)} /> : <div className="flex flex-1 items-center justify-center p-4">{node.fileId && <a className="underline" href={collaborationFileUrl(roomId, node.fileId)} download>{node.title || "下载附件"}</a>}</div>}
                    </div>;
                })}
                {selection && <div data-selection-box className="pointer-events-none absolute z-30 border" style={{ left: Math.min(selection.start.x, selection.end.x), top: Math.min(selection.start.y, selection.end.y), width: Math.abs(selection.end.x - selection.start.x), height: Math.abs(selection.end.y - selection.start.y), borderColor: theme.node.activeStroke, background: theme.node.activeStroke, opacity: 0.2 }} />}
                {sync.cursors.map((cursor) => {
                    const hue = [...cursor.userId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0);
                    const color = `hsl(${hue} 65% 55%)`;
                    return <div key={cursor.userId} data-collaboration-cursor={cursor.userId} className="pointer-events-none absolute z-20 origin-top-left" style={{ left: cursor.position.x, top: cursor.position.y, transform: `scale(${1 / viewport.k})`, color }}>
                        <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true"><path d="M2 2L17 14L10 15L7 22Z" fill="currentColor" stroke={theme.canvas.background} strokeWidth="1.5" /></svg>
                        <span className="absolute left-4 top-5 max-w-40 truncate rounded px-1.5 py-0.5 text-xs" style={{ background: theme.node.panel, color, border: `1px solid ${color}` }}>{cursor.username}</span>
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
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 pb-4 pt-2 sm:inset-x-auto sm:bottom-2 sm:left-1/2 sm:min-w-max sm:-translate-x-1/2 sm:flex-nowrap" style={{ color: theme.node.text, background: theme.canvas.background }}>
                <Tooltip title="撤销 Ctrl/⌘+Z"><Button type="text" aria-label="撤销" disabled={!sync.canEdit || !sync.history.canUndo || busy} icon={<Undo2 className="size-4" />} onClick={() => void sync.changeHistory("undo").catch(reportError)} /></Tooltip>
                <Tooltip title="重做 Ctrl+Y / Ctrl/⌘+Shift+Z"><Button type="text" aria-label="重做" disabled={!sync.canEdit || !sync.history.canRedo || busy} icon={<Redo2 className="size-4" />} onClick={() => void sync.changeHistory("redo").catch(reportError)} /></Tooltip>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<Plus className="size-4" />} onClick={() => void create("text").catch(reportError)}>协作文本</Button>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>共享图片 / 文件</Button>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<Workflow className="size-4" />} onClick={() => setTemplatesOpen(true)}>节点模板</Button>
                <Button type="text" disabled={!sync.canEdit || busy} icon={<LockKeyhole className="size-4" />} onClick={() => void create("private").catch(reportError)}>隐私节点</Button>
                <span className="ml-3 text-xs opacity-60">{Math.round(viewport.k * 100)}%</span>
            </div>
            <div className="pointer-events-none absolute bottom-28 left-4 right-4 text-center text-xs sm:bottom-20 sm:left-1/2 sm:right-auto sm:-translate-x-1/2" style={{ color: theme.node.muted }}>
                {wiring ? <span>拖到下游节点即可连接，也可指定输入端口 · Esc 取消</span> : chosenEdge ? <Space className="pointer-events-auto">
                    <Button type="text" disabled={!edgeEditable} icon={<Cable className="size-4" />} onClick={() => { const target = sync.nodes.find((node) => node.id === chosenEdge.target)!; setWiring({ source: chosenEdge.source, edge: chosenEdge, point: target.position }); }}>重连输入</Button>
                    <Button type="text" disabled={!edgeEditable} icon={<Unplug className="size-4" />} onClick={() => void disconnect(chosenEdge)}>断开连线</Button>
                </Space> : selected.length ? <Space className="pointer-events-auto"><span>已选择 {selected.length} 个节点 · 拖动标题可一起移动</span><Button type="text" disabled={!sync.canEdit || busy} icon={<Trash2 className="size-4" />} onClick={() => remove(selected)}>删除所选</Button></Space> : <span>Ctrl/⌘+拖拽框选 · Ctrl/⌘+点击多选 · 输出拖到节点连线 · 右键线断开</span>}
            </div>
            <Modal open={Boolean(portChoice)} title="选择输入类型" footer={null} onCancel={() => setPortChoice(null)} destroyOnHidden>
                <p className="mb-4 text-sm opacity-70">这个输出可以接入多种输入，请选择本次连接要传递的数据类型。</p>
                <Space wrap>{portChoice?.ports.map((port) => <Button key={port.id} onClick={() => void connectTo(portChoice.target, port.id, portChoice.wire)}>{port.label}</Button>)}</Space>
            </Modal>
            <input ref={fileRef} type="file" className="hidden" aria-label="上传共享文件" onChange={(event) => void upload(event.target.files?.[0])} />
            {privateId && <PrivateDialog roomId={roomId} nodeId={privateId} onClose={closePrivate} canEdit={sync.canEdit} />}
            {templatesOpen && <TemplatesDialog onClose={closeTemplates} onCreate={async (template) => { await create(template.kind, undefined, template); }} />}
            {customNode && <CustomDialog key={customNode.id} roomId={roomId} node={customNode} canEdit={sync.canEdit} onClose={() => setCustomId(null)} onSave={async (version, fields) => { await sync.mutate([{ type: "update", id: customNode.id, version, fields }]); }} />}
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
