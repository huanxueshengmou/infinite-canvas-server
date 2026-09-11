import { useState } from "react";
import { Alert, App, Button, Form, Input, Modal, Select, Space } from "antd";
import { collaborationApi, type NodeFields, type SharedNode } from "@/services/api/collaboration";
import { TemplateSaveButton } from "./templates-dialog";

type CustomForm = { title: string; content: string; outputType: "text" | "json" };

export function CustomDialog({ roomId, node, canEdit, onClose, onSave }: { roomId: string; node: SharedNode; canEdit: boolean; onClose: () => void; onSave: (version: number, fields: NodeFields) => Promise<void> }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<CustomForm>();
    const [base, setBase] = useState({ version: node.version, data: { title: node.title, content: node.content, outputType: node.outputType || "text" } });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [output, setOutput] = useState<{ text: string; revision: number } | null>(null);
    const submit = async (evaluate = false) => {
        setBusy(true);
        try {
            const data = await form.validateFields();
            if (canEdit && (data.title !== base.data.title || data.content !== base.data.content || data.outputType !== base.data.outputType)) {
                await onSave(base.version, data);
                setBase({ version: base.version + 1, data });
            }
            if (evaluate) setOutput(await collaborationApi(`/rooms/${roomId}/nodes/${node.id}/evaluate`, { method: "POST", body: "{}" }));
            else message.success("自定义节点已保存");
            setError("");
        } catch (error) { setError(error instanceof Error ? error.message : "请检查节点内容"); }
        finally { setBusy(false); }
    };
    return <Modal open title="自定义节点" footer={null} onCancel={onClose} width={720} destroyOnHidden maskClosable={false}>
        <p className="mb-3 text-sm opacity-70">这个节点的配置和输出对画布成员可见。把上游的输出连接到左侧输入，点击计算即可查看实际结果；下游 API 执行时也会重新计算。</p>
        <p className="mb-4 select-text text-xs opacity-65">{`文本：{{input.text}}　JSON 字段：{{input.json.prompt}}　图片引用：{{image.fileId}}。JSON 中请将占位符写在双引号内，系统会保留数字、布尔和对象类型。`}</p>
        {error && <Alert type="error" title={error} className="mb-4" />}
        <Form form={form} layout="vertical" initialValues={base.data} disabled={!canEdit || busy}>
            <Form.Item name="title" label="节点名称" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="outputType" label="输出格式"><Select options={[{ value: "text", label: "文本拼接" }, { value: "json", label: "JSON 数据" }]} /></Form.Item>
            <Form.Item name="content" label="内容模板"><Input.TextArea aria-label="自定义节点内容" autoSize={{ minRows: 6, maxRows: 14 }} spellCheck={false} /></Form.Item>
        </Form>
        <Space wrap>
            <Button disabled={!canEdit} loading={busy} onClick={() => void submit()}>保存节点</Button>
            <Button type="primary" loading={busy} onClick={() => void submit(true)}>计算输出</Button>
            <TemplateSaveButton disabled={busy} getTemplate={async () => { const data = await form.validateFields(); return { name: data.title, kind: "custom", content: data.content, outputType: data.outputType }; }} />
        </Space>
        {output && <div className="mt-5"><p className="mb-2 text-xs opacity-65">本次计算结果 · 画布版本 {output.revision} · 上游修改后可重新计算</p><pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap break-all rounded border border-current/15 p-3 text-sm">{output.text}</pre></div>}
    </Modal>;
}
