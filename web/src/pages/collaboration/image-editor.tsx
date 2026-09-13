import { useEffect, useState } from "react";
import { Alert, App, Button, Modal, Space, Spin, Tooltip } from "antd";
import { ClipboardCopy, Redo2, Save, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { collaborationFileUrl, type DrawingItem, type SharedNode } from "@/services/api/collaboration";
import { DrawingSurface, DrawingToolbar } from "./drawing-surface";
import { initialDrawingSettings, renderEditedImage, type CropRect } from "./drawing";

type EditState = { drawing: DrawingItem[]; crop: CropRect | null };

export function ImageEditor({ roomId, node, onClose, onReplace }: { roomId: string; node: SharedNode; onClose: () => void; onReplace: (blob: Blob) => Promise<void> }) {
    const { message } = App.useApp();
    const [image, setImage] = useState<HTMLImageElement | null>(null), [error, setError] = useState("");
    const [settings, setSettings] = useState(initialDrawingSettings);
    const [history, setHistory] = useState<{ past: EditState[]; current: EditState; future: EditState[] }>({ past: [], current: { drawing: [], crop: null }, future: [] });
    const [busy, setBusy] = useState(false), [result, setResult] = useState<{ blob: Blob; url: string } | null>(null);
    const size = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;
    const viewport = useImageEditorViewport(size, true);
    useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
    const commit = (next: EditState) => setHistory((state) => ({ past: [...state.past, state.current], current: next, future: [] }));
    const undo = () => setHistory((state) => state.past.length ? { past: state.past.slice(0, -1), current: state.past.at(-1)!, future: [state.current, ...state.future] } : state);
    const redo = () => setHistory((state) => state.future.length ? { past: [...state.past, state.current], current: state.future[0], future: state.future.slice(1) } : state);
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (busy || result || !(event.ctrlKey || event.metaKey) || event.altKey || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable='true']"))) return;
            const key = event.key.toLowerCase();
            if (!["z", "y"].includes(key)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (key === "y" || event.shiftKey) redo(); else undo();
        };
        window.addEventListener("keydown", keydown, true);
        return () => window.removeEventListener("keydown", keydown, true);
    }, [busy, result]);
    const finish = async () => {
        if (!image) return;
        setBusy(true); setError("");
        try { const blob = await renderEditedImage(image, history.current.drawing, history.current.crop); setResult({ blob, url: URL.createObjectURL(blob) }); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    const save = async (destination: "replace" | "clipboard") => {
        if (!result) return;
        setBusy(true);
        try {
            if (destination === "replace") await onReplace(result.blob);
            else {
                if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("当前浏览器不支持复制图片，请使用支持图片剪贴板的浏览器");
                await navigator.clipboard.write([new ClipboardItem({ "image/png": result.blob })]);
            }
            message.success(destination === "replace" ? "图片已更新，可通过撤销恢复原图" : "已复制图片，可用 Ctrl/⌘+V 粘贴"); onClose();
        } catch (error) { message.error((error as Error).message || "保存失败，编辑结果仍保留，请重试"); }
        finally { setBusy(false); }
    };
    return <>
        <Modal open title="编辑图片" width={980} centered onCancel={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy} destroyOnHidden footer={<Space><Button aria-label="取消图片编辑" disabled={busy} onClick={onClose}>取消</Button><Button type="primary" aria-label="完成图片编辑" loading={busy && !result} disabled={!image || busy} onClick={() => void finish()}>完成编辑</Button></Space>}>
            <div data-canvas-no-zoom className="space-y-3">
                {error && <Alert type="error" title={error} />}
                <DrawingToolbar value={settings} onChange={setSettings} crop disabled={!image || busy || Boolean(result)} />
                <div ref={viewport.viewportRef} {...viewport.panHandlers} className={`relative h-[min(58vh,620px)] min-h-48 rounded-lg border border-current/15 ${viewport.scrollClassName}`}>
                    {!image && !error && <div className="absolute inset-0 flex items-center justify-center"><Spin /></div>}
                    <div className="relative" style={viewport.contentStyle}><div ref={viewport.stageRef} className="absolute overflow-hidden" style={viewport.stageStyle}>
                        <img src={collaborationFileUrl(roomId, node.fileId!)} onLoad={(event) => setImage(event.currentTarget)} onError={() => setError("图片无法加载或解码，请关闭编辑窗口后下载原文件")} className="absolute inset-0 h-full w-full" draggable={false} alt="待编辑图片" />
                        {size && <DrawingSurface {...size} drawing={history.current.drawing} settings={settings} disabled={busy || Boolean(result)} crop={history.current.crop} onAdd={(mark) => commit({ ...history.current, drawing: [...history.current.drawing, mark] })} onCrop={(crop) => commit({ ...history.current, crop })} />}
                    </div></div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Space size="small"><Tooltip title="撤销 Ctrl/⌘+Z"><Button type="text" aria-label="撤销图片编辑" icon={<Undo2 className="size-4" />} disabled={!history.past.length || busy} onClick={undo} /></Tooltip><Tooltip title="重做"><Button type="text" aria-label="重做图片编辑" icon={<Redo2 className="size-4" />} disabled={!history.future.length || busy} onClick={redo} /></Tooltip>{history.current.crop && <Button type="text" disabled={busy} onClick={() => commit({ ...history.current, crop: null })}>取消裁剪</Button>}</Space>
                    <Space size="small"><Button type="text" aria-label="缩小编辑图片" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} onClick={viewport.zoomOut} /><button type="button" className="text-xs" onClick={viewport.resetZoom}>{Math.round(viewport.zoom * 100)}%</button><Button type="text" aria-label="放大编辑图片" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} onClick={viewport.zoomIn} /><span className="text-xs opacity-60">滚轮缩放 · 空格或中键拖动</span></Space>
                </div>
            </div>
        </Modal>
        <Modal open={Boolean(result)} title="保存编辑结果" centered onCancel={() => setResult(null)} closable={!busy} maskClosable={!busy} keyboard={!busy} footer={null} destroyOnHidden>
            <div data-canvas-no-zoom className="space-y-4">
                {result && <img alt="编辑结果预览" src={result.url} className="mx-auto max-h-64 max-w-full object-contain" />}
                <p className="text-sm opacity-70">结果保存为 PNG。覆盖原图可撤销；复制后可粘贴到画布或其他应用。</p>
                <div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={() => setResult(null)}>继续编辑</Button><Button aria-label="复制编辑图片到剪贴板" icon={<ClipboardCopy className="size-4" />} disabled={busy} onClick={() => void save("clipboard")}>复制到剪贴板</Button><Button type="primary" aria-label="覆盖原图" icon={<Save className="size-4" />} loading={busy} disabled={busy} onClick={() => void save("replace")}>覆盖原图</Button></div>
            </div>
        </Modal>
    </>;
}
