import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Modal, Select, Space, Tabs } from "antd";
import { collaborationApi, type SharedRoom } from "@/services/api/collaboration";

type Share = { id: string; role: string; expires_at: number; revoked: number; protected: number };
type Member = { id: string; username: string; role: string; revoked: number | null; expires_at: number | null };

export function ShareDialog({ room, onClose, shareTtlMs }: { room: SharedRoom; onClose: () => void; shareTtlMs: number }) {
    const { message, modal } = App.useApp();
    const [shares, setShares] = useState<Share[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [link, setLink] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const load = async () => {
        try {
            const [shares, members] = await Promise.all([collaborationApi<Share[]>(`/rooms/${room.id}/shares`), collaborationApi<Member[]>(`/rooms/${room.id}/members`)]);
            setShares(shares); setMembers(members); setError("");
        } catch (error) { setError((error as Error).message); }
    };
    useEffect(() => { void load(); }, [room.id]);
    const create = async (values: { role: "viewer" | "editor"; password?: string; expiresAt?: string }) => {
        setBusy(true);
        try {
            const expiresAt = values.expiresAt ? new Date(values.expiresAt).getTime() : Date.now() + shareTtlMs;
            const result = await collaborationApi<{ token: string }>(`/rooms/${room.id}/shares`, { method: "POST", body: JSON.stringify({ role: values.role, password: values.password || "", expiresAt }) });
            setLink(`${window.location.origin}/collaboration#invite=${encodeURIComponent(result.token)}`);
            await load();
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    const change = async (path: string, method: string, body?: object) => {
        try { await collaborationApi(path, { method, body: body ? JSON.stringify(body) : undefined }); await load(); }
        catch (error) { setError((error as Error).message); }
    };
    return (
        <Modal open title="分享与成员权限" onCancel={onClose} footer={null} width={640} destroyOnHidden>
            <p className="mb-4 text-sm opacity-70">链接持有人需登录或注册后加入。隐私节点内容始终仅创建者可见，画布所有者也无法查看他人的隐私内容。</p>
            {error && <Alert type="error" title={error} className="mb-4" />}
            <Tabs items={[
                { key: "shares", label: "分享链接", children: <>
                    <Form layout="vertical" initialValues={{ role: "viewer" }} onFinish={create}>
                        <Form.Item name="role" label="访问权限"><Select options={[{ value: "viewer", label: "仅查看" }, { value: "editor", label: "可编辑" }]} /></Form.Item>
                        <Form.Item name="password" label="分享口令（可选）"><Input.Password autoComplete="new-password" /></Form.Item>
                        <Form.Item name="expiresAt" label={`到期时间（留空使用 ${Math.round(shareTtlMs / 86400000)} 天）`}><Input type="datetime-local" /></Form.Item>
                        <Button htmlType="submit" loading={busy}>创建分享链接</Button>
                    </Form>
                    {link && <div className="my-4 space-y-2"><Input.TextArea readOnly value={link} autoSize aria-label="新分享链接" /><Button onClick={() => void navigator.clipboard.writeText(link).then(() => message.success("链接已复制"), () => message.error("复制失败，请手动选择链接"))}>复制链接</Button><p className="text-xs opacity-60">此链接只在本次创建时显示，请妥善保存。</p></div>}
                    <div className="mt-5 space-y-3">{shares.map((share) => <div key={share.id} className="flex items-center justify-between gap-3 border-t border-current/10 pt-3 text-sm">
                        <span>{share.role === "viewer" ? "仅查看" : "可编辑"} · {share.protected ? "有口令" : "无口令"}<br /><span className="text-xs opacity-60">{new Date(share.expires_at).toLocaleString()} 到期</span></span>
                        {share.revoked ? <span className="opacity-60">已撤销</span> : <Button danger type="text" onClick={() => modal.confirm({ title: "撤销此链接及由它授予的访问权限？", content: "相关成员的在线连接也会断开。", onOk: () => change(`/rooms/${room.id}/shares/${share.id}`, "DELETE") })}>撤销</Button>}
                    </div>)}</div>
                </> },
                { key: "members", label: "成员", children: <div className="space-y-3">{!members.length && <p className="opacity-60">还没有其他成员。</p>}{members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-current/10 pb-3">
                    <span>{member.username}{member.revoked || (member.expires_at && member.expires_at <= Date.now()) ? "（授权已失效）" : ""}</span>
                    <Space><Select value={member.role} options={[{ value: "viewer", label: "仅查看" }, { value: "editor", label: "可编辑" }]} onChange={(role) => void change(`/rooms/${room.id}/members/${member.id}`, "PATCH", { role })} /><Button danger type="text" onClick={() => modal.confirm({ title: `移除 ${member.username} 的访问权限？`, content: "若该成员仍持有有效分享链接，需要同时撤销相应链接以防重新加入。", onOk: () => change(`/rooms/${room.id}/members/${member.id}`, "DELETE") })}>移除</Button></Space>
                </div>)}</div> },
            ]} />
        </Modal>
    );
}
