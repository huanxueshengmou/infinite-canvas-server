import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, Modal, Select, Space } from "antd";
import { collaborationApi, type PrivateData, type PrivateRecord } from "@/services/api/collaboration";

export function PrivateDialog({ roomId, nodeId, onClose, canEdit }: { roomId: string; nodeId: string; onClose: () => void; canEdit: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<PrivateData>();
    const [record, setRecord] = useState<PrivateRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    const controller = useRef<AbortController | null>(null);
    const path = `/rooms/${roomId}/private/${nodeId}`;
    useEffect(() => {
        alive.current = true;
        const abort = new AbortController();
        void collaborationApi<PrivateRecord>(path, { signal: abort.signal }).then((record) => {
            if (!alive.current) return;
            setRecord(record); form.setFieldsValue(record.data);
        }).catch((error) => { if (alive.current && !abort.signal.aborted) setError(error.message); });
        const hide = () => { if (document.visibilityState === "hidden") onClose(); };
        document.addEventListener("visibilitychange", hide);
        window.addEventListener("offline", onClose);
        return () => { alive.current = false; abort.abort(); controller.current?.abort(); form.resetFields(); document.removeEventListener("visibilitychange", hide); window.removeEventListener("offline", onClose); };
    }, [form, path, onClose]);
    const save = async () => {
        if (!record) return null;
        const data = await form.validateFields();
        const result = await collaborationApi<{ version: number }>(path, { method: "PUT", body: JSON.stringify({ version: record.version, data }) });
        if (!alive.current) return null;
        const next = { ...record, data, version: result.version };
        setRecord(next); setError("");
        return next;
    };
    const submit = async (run = false) => {
        setBusy(true);
        try {
            const saved = await save();
            if (run && saved && alive.current) {
                setRunning(true);
                controller.current = new AbortController();
                const result = await collaborationApi<{ result: PrivateRecord["result"] }>(`${path}/run`, { method: "POST", body: JSON.stringify({ version: saved.version }), signal: controller.current.signal });
                if (alive.current) setRecord({ ...saved, result: result.result });
            } else if (saved) message.success("隐私内容已保存");
        } catch (error) { if (alive.current) setError((error as Error).message); }
        finally { if (alive.current) { setBusy(false); setRunning(false); } }
    };
    return (
        <Modal open title="我的隐私节点" onCancel={onClose} footer={null} width={760} destroyOnHidden maskClosable={false}>
            <p className="mb-4 text-sm opacity-70">此处的内容、密钥和请求结果仅当前账户可见，不会自动发布到画布。离开页面、切换标签页或连接失效时会关闭此窗口。</p>
            {error && <Alert type="error" title={error} className="mb-4" />}
            {!record ? <p>正在验证权限并读取隐私内容…</p> : <>
                <Form form={form} layout="vertical" disabled={!canEdit || busy}>
                    <Form.Item name="title" label="私有名称" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item>
                    <Form.Item name="note" label="私有备注"><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item>
                    <Form.Item name={["request", "url"]} label="API 地址（HTTPS，域名需由管理员批准）"><Input placeholder="https://api.example.com/v1/chat/completions" autoComplete="off" /></Form.Item>
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name={["request", "method"]} label="请求方法"><Select options={[{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }]} /></Form.Item>
                        <Form.Item name={["request", "header"]} label="密钥请求头"><Select options={[{ value: "Authorization", label: "Authorization: Bearer" }, { value: "x-api-key", label: "x-api-key" }]} /></Form.Item>
                    </div>
                    <Form.Item name={["request", "apiKey"]} label="API 密钥"><Input.Password autoComplete="new-password" /></Form.Item>
                    <Form.Item name={["request", "body"]} label="请求正文"><Input.TextArea autoSize={{ minRows: 5, maxRows: 14 }} spellCheck={false} /></Form.Item>
                </Form>
                <Space wrap><Button disabled={!canEdit} loading={busy && !running} onClick={() => void submit()}>保存隐私内容</Button><Button type="primary" disabled={!canEdit} loading={running} onClick={() => void submit(true)}>保存并发送 API 请求</Button></Space>
                {record.result && <div className="mt-5"><p className="mb-2 text-sm">私有结果 · HTTP {record.result.status}</p><pre className="max-h-80 select-text overflow-auto whitespace-pre-wrap break-all rounded border border-current/15 p-3 text-xs">{record.result.text}</pre></div>}
            </>}
        </Modal>
    );
}
