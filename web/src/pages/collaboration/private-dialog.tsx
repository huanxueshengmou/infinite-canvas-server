import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Modal, Select, Space, Switch } from "antd";
import { collaborationApi, type PrivateData, type PrivateRecord } from "@/services/api/collaboration";
import { TemplateSaveButton } from "./templates-dialog";
import { PrivateResults } from "./private-results";

export function PrivateDialog({ roomId, nodeId, onClose, canEdit }: { roomId: string; nodeId: string; onClose: () => void; canEdit: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<PrivateData>();
    const [record, setRecord] = useState<PrivateRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [pollEnabled, setPollEnabled] = useState(false);
    const fields = Form.useWatch("fields", form) as PrivateData["fields"] | undefined;
    const bodyFormat = Form.useWatch(["request", "bodyFormat"], form) as PrivateData["request"]["bodyFormat"] | undefined;
    const method = Form.useWatch(["request", "method"], form) as PrivateData["request"]["method"] | undefined;
    const alive = useRef(true);
    const controller = useRef<AbortController | null>(null);
    const path = `/rooms/${roomId}/private/${nodeId}`;
    useEffect(() => {
        alive.current = true;
        const abort = new AbortController();
        void collaborationApi<PrivateRecord>(path, { signal: abort.signal }).then((record) => {
            if (!alive.current) return;
            setRecord(record); form.setFieldsValue(record.data); setPollEnabled(Boolean(record.data.poll));
        }).catch((error) => { if (alive.current && !abort.signal.aborted) setError(error.message); });
        const hide = () => { if (document.visibilityState === "hidden") onClose(); };
        document.addEventListener("visibilitychange", hide);
        window.addEventListener("offline", onClose);
        return () => { alive.current = false; abort.abort(); controller.current?.abort(); form.resetFields(); document.removeEventListener("visibilitychange", hide); window.removeEventListener("offline", onClose); };
    }, [form, path, onClose]);
    const formData = async () => {
        await form.validateFields();
        const data = form.getFieldsValue(true) as PrivateData;
        if (!pollEnabled) delete data.poll;
        return data;
    };
    const save = async () => {
        if (!record) return null;
        const data = await formData();
        if (JSON.stringify(data) === JSON.stringify(record.data)) return record;
        const result = await collaborationApi<{ version: number }>(path, { method: "PUT", body: JSON.stringify({ version: record.version, data }) });
        if (!alive.current) return null;
        const next = { ...record, data, version: result.version };
        setRecord(next); setError("");
        return next;
    };
    const submit = async (action?: "run" | "poll") => {
        setBusy(true);
        try {
            const saved = await save();
            if (action && saved && alive.current) {
                setRunning(true);
                controller.current = new AbortController();
                const result = await collaborationApi<Pick<PrivateRecord, "result" | "media">>(`${path}/run`, { method: "POST", body: JSON.stringify({ version: saved.version, action }), signal: controller.current.signal });
                if (alive.current) { setRecord({ ...saved, ...result }); setError(""); }
            } else if (saved) message.success("隐私内容已保存");
        } catch (error) { if (alive.current) setError((error as Error).message); }
        finally { if (alive.current) { setBusy(false); setRunning(false); } }
    };
    const runLabel = pollEnabled ? "提交新任务" : "保存并发送 API 请求";
    return (
        <Modal open title="我的隐私节点" onCancel={onClose} footer={null} width={850} destroyOnHidden maskClosable={false}>
            <p className="mb-4 text-sm opacity-70">此处的内容、密钥和请求结果仅当前账户可见，不会自动发布到画布。离开页面、切换标签页或连接失效时会关闭此窗口。</p>
            {error && <Alert type="error" title={error} className="mb-4" />}
            {!record ? <p>正在验证权限并读取隐私内容…</p> : <>
                <Form form={form} layout="vertical" disabled={!canEdit || busy}>
                    <Form.Item name="title" label="私有名称" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item>
                    <Form.Item name={["request", "apiKey"]} label="API 密钥"><Input.Password autoComplete="new-password" /></Form.Item>
                    {(fields || record.data.fields).map((field, index) => <Form.Item key={index} name={["fields", index, "value"]} label={field.label || field.name} valuePropName={field.type === "boolean" ? "checked" : "value"}>
                        {field.type === "number" ? <InputNumber className="!w-full" /> : field.type === "boolean" ? <Switch /> : <Input.TextArea autoComplete="off" autoSize={{ minRows: 1, maxRows: 5 }} />}
                    </Form.Item>)}
                    <Collapse className="mb-4" items={[{ key: "request", label: "请求配置与自定义参数", forceRender: true, children: <>
                        <Form.Item name="category" label="结果类型"><Select options={[{ value: "request", label: "通用请求" }, { value: "image", label: "图片生成" }, { value: "video", label: "视频生成" }, { value: "llm", label: "语言模型" }]} /></Form.Item>
                        <Form.Item name="note" label="私有备注"><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item>
                        <Form.Item name={["request", "url"]} label="API 地址（HTTPS，遵循服务管理中的域名规则）"><Input placeholder="https://api.example.com/v1/chat/completions" autoComplete="off" /></Form.Item>
                        <div className="grid grid-cols-2 gap-4">
                            <Form.Item name={["request", "method"]} label="请求方法"><Select options={["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((value) => ({ value, label: value }))} /></Form.Item>
                            <Form.Item name={["request", "authMode"]} label="认证方式"><Select options={[{ value: "auto", label: "自动（Authorization 使用 Bearer）" }, { value: "raw", label: "原样请求头（可填 Basic 等完整值）" }, { value: "none", label: "不使用 API 密钥" }]} /></Form.Item>
                        </div>
                        <Form.Item name={["request", "header"]} label="密钥请求头名称"><Input placeholder="Authorization / x-api-key / x-goog-api-key" autoComplete="off" /></Form.Item>
                        <Form.List name={["request", "headers"]}>{(items, { add, remove }) => <div className="mb-4">
                            <p className="mb-2 text-sm">自定义请求头</p>
                            {items.map((item) => <div key={item.key} className="mb-3 flex flex-wrap items-center gap-2">
                                <Form.Item name={[item.name, "name"]} className="!mb-0 min-w-32 flex-1" rules={[{ required: true }]}><Input aria-label="自定义请求头名称" placeholder="anthropic-version" /></Form.Item>
                                <Form.Item name={[item.name, "value"]} className="!mb-0 min-w-40 flex-1"><Input.Password aria-label="自定义请求头值" autoComplete="new-password" placeholder="请求头值" /></Form.Item>
                                <Form.Item name={[item.name, "secret"]} valuePropName="checked" className="!mb-0"><Switch aria-label="保存模板时清空请求头值" size="small" /></Form.Item><span className="text-xs opacity-65">模板中清空</span>
                                <Button type="text" onClick={() => remove(item.name)}>移除</Button>
                            </div>)}
                            <Button type="text" onClick={() => add({ name: "", value: "", secret: true })}>添加请求头</Button>
                            <p className="mt-2 text-xs opacity-65">API 密钥始终不会复制到模板；自定义请求头默认也清空值。公开的版本号等固定参数可关闭「模板中清空」。</p>
                        </div>}</Form.List>
                        <p className="mb-3 select-text text-xs opacity-65">{`连线输入：{{input.text}}、{{input.json.字段}}、{{image.dataUrl}}、{{audio.dataUrl}}；参数：{{params.参数名}}。完整 JSON 占位符保留原始类型，末尾加 ? 表示未连接时省略该字段。`}</p>
                        <Form.Item name={["request", "bodyFormat"]} label="请求正文格式"><Select disabled={method === "GET" || method === "HEAD"} options={[{ value: "json", label: "JSON（application/json）" }, { value: "urlencoded", label: "URL 编码表单" }, { value: "multipart", label: "文件表单（multipart/form-data）" }, { value: "text", label: "原始文本 / XML" }]} /></Form.Item>
                        {bodyFormat === "text" && <Form.Item name={["request", "contentType"]} label="正文 Content-Type"><Input placeholder="text/plain / application/xml" /></Form.Item>}
                        <Form.Item name={["request", "body"]} label={bodyFormat === "text" ? "请求正文（文本模板）" : bodyFormat === "multipart" || bodyFormat === "urlencoded" ? "表单字段（JSON 模板，数组作为重复字段）" : "请求正文（JSON 模板）"}><Input.TextArea disabled={method === "GET" || method === "HEAD"} autoSize={{ minRows: 5, maxRows: 14 }} spellCheck={false} /></Form.Item>
                        {bodyFormat === "multipart" && <p className="mb-3 select-text text-xs opacity-65">{'例如 {"prompt":"{{input.text}}","image":"{{image.dataUrl}}"}。附件会按流上传为文件，不转成整段 base64。'}</p>}
                        {(method === "GET" || method === "HEAD") && <p className="mb-3 text-xs opacity-65">该方法不发送正文，请将查询参数写入 API 地址；占位符会自动进行 URL 编码。</p>}
                        <Form.List name="fields">{(items, { add, remove }) => <div className="mb-4">
                            <p className="mb-2 text-sm">自定义参数：变量名、显示名称、类型</p>
                            {items.map((item) => <div key={item.key} className="mb-2 flex flex-wrap gap-2">
                                <Form.Item name={[item.name, "name"]} className="!mb-0 flex-1" rules={[{ required: true }, { pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/, message: "以英文字母开头，仅字母、数字和下划线" }]}><Input placeholder="变量名" /></Form.Item>
                                <Form.Item name={[item.name, "label"]} className="!mb-0 flex-1"><Input placeholder="显示名称" /></Form.Item>
                                <Form.Item name={[item.name, "type"]} className="!mb-0"><Select style={{ width: 90 }} options={[{ value: "text", label: "文本" }, { value: "number", label: "数字" }, { value: "boolean", label: "布尔" }]} /></Form.Item>
                                <Button type="text" onClick={() => remove(item.name)}>移除</Button>
                            </div>)}
                            <Button type="text" onClick={() => add({ name: `param${items.length + 1}`, label: "新参数", type: "text", value: "" })}>添加参数</Button>
                        </div>}</Form.List>
                        <Space className="mb-3"><Switch checked={pollEnabled} onChange={(enabled) => { setPollEnabled(enabled); if (enabled && !form.getFieldValue("poll")) form.setFieldValue("poll", { url: "", taskIdPath: "task_id|data.task_id|id|data.id" }); }} /><span>异步任务查询</span></Space>
                        {pollEnabled && <>
                            <Form.Item name={["poll", "url"]} label="状态查询地址"><Input placeholder="https://api.example.com/tasks/{{task.id}}" /></Form.Item>
                            <Form.Item name={["poll", "taskIdPath"]} label="提交响应中的任务 ID 路径（多个路径用 | 分隔）"><Input /></Form.Item>
                            <p className="mb-3 text-xs opacity-65">提交后保留任务 ID，点击「查询任务状态」只查询已有任务。每次请求遵循服务端 API 超时；上游排队时不占用本服务的处理名额。</p>
                        </>}
                    </> }]} />
                </Form>
                <Space wrap>
                    <Button disabled={!canEdit || busy} onClick={() => void submit()}>保存隐私内容</Button>
                    <Button type="primary" aria-label={runLabel} aria-busy={running} disabled={!canEdit || busy} loading={running} onClick={() => void submit("run")}>{runLabel}</Button>
                    {pollEnabled && <Button disabled={!canEdit || busy || !record.result?.taskId} onClick={() => void submit("poll")}>查询任务状态</Button>}
                    <TemplateSaveButton disabled={busy} getTemplate={async () => { const data = await formData(); return { name: data.title, kind: "private", content: "", outputType: "text", privateData: { ...data, request: { ...data.request, apiKey: "", headers: data.request.headers.map((header) => ({ ...header, value: header.secret ? "" : header.value })) } } }; }} />
                </Space>
                {record.result && <PrivateResults key={record.result.id} path={path} record={record} canEdit={canEdit && !busy} />}
            </>}
        </Modal>
    );
}
