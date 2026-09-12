import { useMemo, useState } from "react";
import { Alert, App, Button, Collapse, Input, Modal, Select, Space } from "antd";
import { collaborationApi, type PrivateRecord } from "@/services/api/collaboration";

function fieldValue(value: unknown, path: string): unknown {
    for (const part of path.split(".")) {
        if (!value || typeof value !== "object" || ["__proto__", "prototype", "constructor"].includes(part) || !Object.hasOwn(value, part)) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}

export function PrivateResults({ path, record, canEdit }: { path: string; record: PrivateRecord; canEdit: boolean }) {
    const { message } = App.useApp();
    const [textPath, setTextPath] = useState("$text");
    const [mediaPath, setMediaPath] = useState(record.media[0]?.path || "");
    const [preview, setPreview] = useState(false);
    const [failed, setFailed] = useState(false);
    const [publication, setPublication] = useState<{ kind: "text" | "media"; path: string; title: string; resultId: string; version: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const json = useMemo(() => { try { return JSON.parse(record.result?.text || ""); } catch { return null; } }, [record.result?.text]);
    if (!record.result) return null;
    const selected = textPath === "$text" ? fieldValue(json, "choices.0.message.content") ?? record.result.text : textPath ? fieldValue(json, textPath) : json;
    const selectedText = selected === undefined ? "" : typeof selected === "string" ? selected : JSON.stringify(selected, null, 2);
    const media = record.media.find((entry) => entry.path === mediaPath);
    const mediaUrl = `/api${path}/media?${new URLSearchParams({ path: mediaPath, resultId: record.result.id })}`;
    const stale = record.result.configVersion && record.result.configVersion !== record.version;
    const publishable = canEdit && !stale && record.result.status >= 200 && record.result.status < 300;
    const publish = async () => {
        if (!publication) return;
        setBusy(true);
        try { await collaborationApi(`${path}/publish`, { method: "POST", body: JSON.stringify(publication) }); setPublication(null); message.success("所选结果已创建为公开节点"); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    const prepare = (kind: "text" | "media") => setPublication({ kind, path: kind === "text" ? textPath : mediaPath, title: kind === "text" ? "发布文本" : "生成媒体", resultId: record.result!.id, version: record.version });
    return <div className="mt-5 border-t border-current/15 pt-4">
        <p className="mb-2 text-sm font-medium">私有结果 · HTTP {record.result.status}{record.result.taskId ? ` · 任务 ${record.result.taskId}` : ""}</p>
        {stale ? <Alert type="info" title="配置已修改，这里保留的是上次结果；重新执行后可发布。" className="mb-3" /> : null}
        {record.media.length > 0 && <div className="mb-4">
            <Space wrap className="mb-3">
                <Select aria-label="结果媒体字段" value={mediaPath} style={{ minWidth: 240 }} options={record.media.map((entry) => ({ value: entry.path, label: `${entry.type === "image" ? "图片" : entry.type === "video" ? "视频" : "音频"} · ${entry.path}` }))} onChange={(value) => { setMediaPath(value); setPreview(false); setFailed(false); }} />
                <Button onClick={() => { setFailed(false); setPreview((value) => !value); }}>{preview ? "关闭预览" : "预览所选媒体"}</Button>
                <Button disabled={!publishable || !media} onClick={() => prepare("media")}>发布所选媒体</Button>
            </Space>
            {preview && !failed && (media?.type === "video" ? <video className="max-h-80 w-full" controls preload="metadata" src={mediaUrl} onError={() => setFailed(true)} /> : media?.type === "audio" ? <audio controls src={mediaUrl} onError={() => setFailed(true)} /> : <img className="max-h-80 w-full object-contain" src={mediaUrl} alt="仅自己可见的生成结果" onError={() => setFailed(true)} />)}
            {failed && <Alert type="warning" title="媒体加载失败。请检查结果是否过期，以及媒体域名是否符合服务管理中的域名规则。" />}
        </div>}
        <Collapse items={[{ key: "raw", label: "查看完整原始响应", children: <pre className="max-h-80 select-text overflow-auto whitespace-pre-wrap break-all text-xs">{record.result.text}</pre> }]} />
        <div className="mt-4">
            <p className="mb-2 text-xs opacity-65">选择要公开的文本字段。$text 表示文本结果；JSON 可填写 choices.0.message.content 等字段路径。</p>
            <Space.Compact className="w-full"><Input aria-label="发布结果字段路径" value={textPath} onChange={(event) => setTextPath(event.target.value)} /><Button disabled={!publishable || selected === undefined} onClick={() => prepare("text")}>预览并发布文本</Button></Space.Compact>
        </div>
        <Modal open={Boolean(publication)} title="确认发布到协作画布" onCancel={() => setPublication(null)} onOk={() => void publish()} confirmLoading={busy} okText="确认公开所选结果" okButtonProps={{ disabled: !publication?.title.trim() }}>
            <p className="mb-3 text-sm">发布后，当前和未来获得此画布访问权限的成员都能看到所选结果。已被他人保存的内容无法通过撤销分享收回。</p>
            <Input aria-label="公开结果节点名称" value={publication?.title || ""} onChange={(event) => setPublication((value) => value ? { ...value, title: event.target.value } : null)} className="mb-3" />
            {publication?.kind === "text" ? <pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap break-all border border-current/15 p-3 text-xs">{selectedText}</pre> : <p className="select-text text-sm">将公开媒体字段：{publication?.path}。媒体会复制为画布的受鉴权文件。</p>}
        </Modal>
    </div>;
}
