import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Space } from "antd";
import { Download, FileUp } from "lucide-react";
import { saveAs } from "file-saver";
import { useThemeStore } from "@/stores/use-theme-store";
import type { SharedEdge, SharedNode, SharedRoom } from "@/services/api/collaboration";
import { readBoardArchive, type PreparedArchive } from "./board-archive";
import { importBoardArchive } from "./board-archive-import";

const privacyNote = "隐私 API 节点仅保留位置和连线，私有配置与结果不导出，导入后需重新配置。";

export function ExportBoardDialog({ getSnapshot, onClose }: { getSnapshot: (signal: AbortSignal) => Promise<SharedRoom & { nodes: SharedNode[]; edges: SharedEdge[] }>; onClose: () => void }) {
    const { message } = App.useApp();
    const theme = useThemeStore((state) => state.theme);
    const [busy, setBusy] = useState(false), [progress, setProgress] = useState(""), [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
    const download = async () => {
        if (controller.current) return;
        const abort = new AbortController(); controller.current = abort;
        setBusy(true); setError(""); setProgress("正在等待同步并读取画布…");
        try {
            const snapshot = await getSnapshot(abort.signal);
            const { exportBoardHtml } = await import("./board-archive-export");
            const result = await exportBoardHtml(snapshot, theme, abort.signal, setProgress);
            abort.signal.throwIfAborted(); saveAs(result.blob, result.name);
            message.success("画布 HTML 已导出，可离线打开或重新导入"); onClose();
        } catch (error) {
            if (controller.current === abort) { setError(abort.signal.aborted ? "已取消导出" : (error as Error).message); setProgress(""); }
        } finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
    };
    return <Modal open title="导出离线画布" onCancel={() => busy ? controller.current?.abort() : onClose()} maskClosable={!busy} footer={null}>
        <p className="mb-3 text-sm">导出为一个 HTML 文件，包含节点、连线、分组、白板及图片、视频和附件。断网后可平移、缩放、浏览、播放和下载，也可重新导入继续编辑。</p>
        <p className="mb-3 text-xs opacity-65">{privacyNote}</p>
        <p className="mb-4 text-xs opacity-65">附件越多，HTML 文件越大；导出过程中请保持页面打开。</p>
        {error && <Alert type="error" title={error} className="mb-4" />}
        {progress && <p role="status" className="mb-4 break-all text-sm">{progress}</p>}
        <Space wrap><Button type="primary" aria-label="下载画布 HTML" icon={<Download className="size-4" />} loading={busy} onClick={() => void download()}>下载 HTML</Button><Button onClick={() => busy ? controller.current?.abort() : onClose()}>{busy ? "取消导出" : "关闭"}</Button></Space>
    </Modal>;
}

export function ImportBoardDialog({ onClose, onImported }: { onClose: () => void; onImported: (room: SharedRoom) => void }) {
    const [prepared, setPrepared] = useState<PreparedArchive | null>(null), [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false), [progress, setProgress] = useState(""), [error, setError] = useState("");
    const [created, setCreated] = useState<SharedRoom | null>(null);
    const controller = useRef<AbortController | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
    const read = async (file?: File) => {
        if (!file || controller.current || created) return;
        const abort = new AbortController(); controller.current = abort;
        setBusy(true); setError(""); setPrepared(null);
        try {
            const value = await readBoardArchive(file, abort.signal, setProgress);
            abort.signal.throwIfAborted(); setPrepared(value); setTitle(`${value.archive.title}（导入）`); setProgress("");
        } catch (error) {
            if (controller.current === abort) { setError(abort.signal.aborted ? "已取消读取" : (error as Error).message); setProgress(""); }
        } finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
    };
    const restore = async () => {
        if (!prepared || !title.trim() || controller.current || created) return;
        const abort = new AbortController(); controller.current = abort;
        setBusy(true); setError("");
        try {
            const room = await importBoardArchive(prepared, title.trim(), abort.signal, setProgress, setCreated);
            if (controller.current === abort) onImported(room);
        } catch (error) {
            if (controller.current === abort) { setError(abort.signal.aborted ? "导入已停止" : (error as Error).message); setProgress(""); }
        } finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
    };
    return <Modal open title="导入画布 HTML" onCancel={() => busy ? controller.current?.abort() : onClose()} maskClosable={!busy} footer={null}>
        <p className="mb-3 text-sm">选择本应用导出的 HTML，还原为一张新的协作画布。节点可继续编辑，内嵌附件会上传到当前服务器。</p>
        <p className="mb-4 text-xs opacity-65">{privacyNote}</p>
        <div className="mb-4 rounded-lg border border-dashed border-current/20 p-6 text-center" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) void read(event.dataTransfer.files[0]); }}>
            <input ref={fileInput} type="file" accept=".html,text/html" aria-label="选择画布 HTML 文件" className="hidden" disabled={busy || Boolean(created)} onChange={(event) => { void read(event.target.files?.[0]); event.target.value = ""; }} />
            <Button type="text" icon={<FileUp className="size-4" />} disabled={busy || Boolean(created)} onClick={() => fileInput.current?.click()}>选择 HTML 文件</Button><p className="mt-2 text-xs opacity-65">也可将导出的 HTML 拖到这里</p>
        </div>
        {prepared && <div className="mb-4"><p className="mb-3 text-sm">{prepared.archive.nodes.length} 个节点 · {prepared.archive.edges.length} 条连线 · {prepared.archive.assets.length} 个附件</p><label className="mb-2 block text-sm" htmlFor="imported-board-title">新画布名称</label><Input id="imported-board-title" value={title} disabled={busy || Boolean(created)} onChange={(event) => setTitle(event.target.value)} /></div>}
        {error && <Alert type="error" title={error} className="mb-4" />}
        {created && error && <p className="mb-4 text-sm">已创建的「{created.title}」保留了成功写入的内容，可打开检查。</p>}
        {progress && <p role="status" className="mb-4 break-all text-sm">{progress}</p>}
        <Space wrap>{created && !busy ? <Button type="primary" onClick={() => onImported(created)}>打开已创建画布</Button> : <Button type="primary" aria-label="导入为新画布" loading={busy} disabled={!prepared || !title.trim()} onClick={() => void restore()}>导入为新画布</Button>}<Button onClick={() => busy ? controller.current?.abort() : onClose()}>{busy ? "停止" : "关闭"}</Button></Space>
    </Modal>;
}
