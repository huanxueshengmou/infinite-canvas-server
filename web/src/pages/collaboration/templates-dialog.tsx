import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Modal, Space, Tag } from "antd";
import { FileCode2, FileJson2, Group, Image, LockKeyhole, Paperclip, Presentation, Save, Trash2, Type, Video } from "lucide-react";
import { collaborationApi, type NodeTemplate, type SharedNode, type TemplateInput } from "@/services/api/collaboration";

const nodeTypes: { kind: SharedNode["kind"]; label: string; icon: typeof Type }[] = [
    { kind: "text", label: "协作文本", icon: Type }, { kind: "markdown", label: "Markdown", icon: FileCode2 },
    { kind: "image", label: "图片", icon: Image }, { kind: "video", label: "视频", icon: Video },
    { kind: "file", label: "文件附件", icon: Paperclip }, { kind: "custom", label: "自定义节点", icon: FileJson2 },
    { kind: "private", label: "隐私节点", icon: LockKeyhole },
    { kind: "whiteboard", label: "白板", icon: Presentation }, { kind: "group", label: "画布组", icon: Group },
];

export function TemplateSaveButton({ getTemplate, disabled }: { getTemplate: () => Promise<TemplateInput>; disabled?: boolean }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<TemplateInput | null>(null);
    const [busy, setBusy] = useState(false);
    const open = async () => {
        try { setDraft(await getTemplate()); }
        catch { message.error("请先检查节点配置"); }
    };
    const save = async () => {
        if (!draft) return;
        setBusy(true);
        try { await collaborationApi("/node-templates", { method: "POST", body: JSON.stringify(draft) }); setDraft(null); message.success("已保存到我的节点模板"); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(false); }
    };
    return <>
        <Button disabled={disabled} icon={<Save className="size-4" />} onClick={() => void open()}>另存节点模板</Button>
        <Modal open={Boolean(draft)} title="保存为我的节点模板" onCancel={() => setDraft(null)} onOk={() => void save()} confirmLoading={busy} okButtonProps={{ disabled: !draft?.name.trim() }} okText="保存模板">
            <p className="mb-3 text-sm opacity-70">模板仅自己可见，API 密钥不会复制。以后可从「节点模板」创建新节点，再调整参数。</p>
            <Input aria-label="模板名称" value={draft?.name || ""} onChange={(event) => setDraft((value) => value ? { ...value, name: event.target.value } : null)} placeholder="模板名称" />
        </Modal>
    </>;
}

export function TemplatesDialog({ onClose, onCreate, onAddType }: { onClose: () => void; onCreate: (template: NodeTemplate) => Promise<void>; onAddType: (kind: SharedNode["kind"]) => Promise<void> }) {
    const { message, modal } = App.useApp();
    const [templates, setTemplates] = useState<NodeTemplate[]>([]);
    const [query, setQuery] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    useEffect(() => {
        const abort = new AbortController();
        void collaborationApi<NodeTemplate[]>("/node-templates", { signal: abort.signal }).then(setTemplates).catch((error) => { if (!abort.signal.aborted) setError(error.message); });
        const hide = () => { if (document.visibilityState === "hidden") onClose(); };
        document.addEventListener("visibilitychange", hide);
        return () => { abort.abort(); document.removeEventListener("visibilitychange", hide); };
    }, [onClose]);
    const create = async (template: NodeTemplate) => {
        setBusy(template.id);
        try { await onCreate(template); onClose(); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(null); }
    };
    const addType = async (kind: SharedNode["kind"]) => {
        setBusy(`type:${kind}`);
        try { await onAddType(kind); onClose(); }
        catch (error) { message.error((error as Error).message); }
        finally { setBusy(null); }
    };
    const remove = (template: NodeTemplate) => modal.confirm({ title: `删除模板「${template.name}」？`, content: "已经创建的节点仍然保留。", onOk: async () => {
        await collaborationApi(`/node-templates/${template.id}`, { method: "DELETE" });
        setTemplates((items) => items.filter((item) => item.id !== template.id));
    } });
    return <Modal open title="节点模板" onCancel={onClose} footer={null} width={720} destroyOnHidden>
        <p className="mb-4 text-sm opacity-70">选择节点类型，或使用已有模板。图片、视频和文件也可以直接拖入画布或通过 Ctrl/⌘+V 粘贴。</p>
        <Input.Search aria-label="搜索节点模板" placeholder="搜索节点类型或模板" value={query} onChange={(event) => setQuery(event.target.value)} className="mb-3" />
        {error && <Alert type="error" title={error} />}
        <div className="max-h-[60vh] overflow-auto">
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {nodeTypes.filter((type) => type.label.toLowerCase().includes(query.toLowerCase())).map(({ kind, label, icon: Icon }) => <Button key={kind} type="text" className="!justify-start" aria-label={`添加${label}`} icon={<Icon className="size-4" />} loading={busy === `type:${kind}`} disabled={Boolean(busy)} onClick={() => void addType(kind)}>{label}</Button>)}
            </div>
            {templates.filter((template) => template.name.toLowerCase().includes(query.toLowerCase())).map((template) => {
                const Icon = template.kind === "custom" ? FileJson2 : template.privateData?.category === "image" ? Image : template.privateData?.category === "video" ? Video : LockKeyhole;
                return <div key={template.id} className="flex items-center gap-3 border-b border-current/10 py-4" data-template-id={template.id}>
                    <Icon className="size-6 shrink-0 opacity-70" />
                    <div className="min-w-0 flex-1"><div className="truncate font-medium">{template.name}</div><Space size="small" className="mt-1"><Tag bordered={false}>{template.builtIn ? "内置参考" : "我的模板"}</Tag><span className="text-xs opacity-60">{template.kind === "private" ? "内容仅创建者可见" : "公开协作节点"}</span></Space></div>
                    {!template.builtIn && <Button type="text" aria-label={`删除模板 ${template.name}`} icon={<Trash2 className="size-4" />} onClick={() => remove(template)} />}
                    <Button type="text" aria-label="创建节点" loading={busy === template.id} disabled={Boolean(busy)} onClick={() => void create(template)}>创建节点</Button>
                </div>;
            })}
        </div>
    </Modal>;
}
