import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, App, Button, Form, Input, Modal, Space } from "antd";
import { LockKeyhole, LogOut, Plus, Users } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { collaborationApi, CollaborationError, setCollaborationSession, type CollaborationMeta, type CollaborationSession, type SharedRoom } from "@/services/api/collaboration";
import { CollaborationBoard } from "./board";

// Consume invitation fragments before making any requests. Never store them in local/session storage.
let invitation = "";
if (typeof window !== "undefined" && window.location.pathname.startsWith("/collaboration")) {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (hash.has("invite")) {
        invitation = hash.get("invite") || "";
        window.history.replaceState(null, "", window.location.pathname);
    }
}

export default function CollaborationPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const { roomId } = useParams();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [session, setSession] = useState<CollaborationSession | null>(null);
    const [meta, setMeta] = useState<CollaborationMeta | null>(null);
    const [rooms, setRooms] = useState<SharedRoom[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [register, setRegister] = useState(false);
    const [invite, setInvite] = useState(invitation);
    const [invitePassword, setInvitePassword] = useState("");
    const [error, setError] = useState("");
    const [createOpen, setCreateOpen] = useState(false);
    const [adminOpen, setAdminOpen] = useState(false);
    const [passwordOpen, setPasswordOpen] = useState(false);
    const [hosts, setHosts] = useState("");
    const [adminStatus, setAdminStatus] = useState<{ lastBackup: { createdAt: string } | null; backupError: string | null } | null>(null);

    const acceptSession = (value: CollaborationSession | null) => { setSession(value); setCollaborationSession(value); };
    const loadRooms = async () => { setRooms(await collaborationApi<SharedRoom[]>("/rooms")); };
    useEffect(() => {
        let active = true;
        void Promise.all([
            collaborationApi<CollaborationMeta>("/meta"),
            collaborationApi<CollaborationSession>("/auth/session").catch((error) => { if (error instanceof CollaborationError && error.status === 401) return null; throw error; }),
        ]).then(([meta, session]) => {
            if (!active) return;
            setMeta(meta); acceptSession(session); setLoading(false);
        }).catch((error) => { if (active) { setError(error.message); setLoading(false); } });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        if (session && !roomId) void loadRooms().catch((error) => setError(error.message));
    }, [session, roomId]);
    useEffect(() => {
        if (!session) return;
        const timeout = setTimeout(() => { acceptSession(null); setRooms([]); setError("登录已过期，请重新登录。"); }, Math.max(1, session.expiresAt - Date.now()));
        return () => clearTimeout(timeout);
    }, [session]);

    const authenticate = async (values: { username: string; password: string; invitePassword?: string }) => {
        setBusy(true); setError("");
        try {
            const data = await collaborationApi<CollaborationSession & { roomId?: string }>(register ? "/auth/register" : "/auth/login", {
                method: "POST", body: JSON.stringify(register ? { username: values.username, password: values.password, inviteToken: invite, invitePassword: values.invitePassword || "" } : { username: values.username, password: values.password }),
            });
            acceptSession(data);
            if (data.roomId) { setInvite(""); invitation = ""; navigate(`/collaboration/${data.roomId}`); }
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    const join = async () => {
        setBusy(true);
        try {
            const data = await collaborationApi<{ roomId: string }>("/shares/join", { method: "POST", body: JSON.stringify({ token: invite, password: invitePassword }) });
            setInvite(""); invitation = ""; setInvitePassword(""); setError(""); navigate(`/collaboration/${data.roomId}`);
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
    };
    const logout = async () => {
        try { await collaborationApi("/auth/logout", { method: "POST" }); }
        catch (error) { message.error((error as Error).message); return; }
        acceptSession(null); setRooms([]); setAdminOpen(false); setAdminStatus(null); navigate("/collaboration");
    };
    const openAdmin = async () => {
        try {
            const [providers, status] = await Promise.all([collaborationApi<{ hosts: string[] }>("/admin/providers"), collaborationApi<{ lastBackup: { createdAt: string } | null; backupError: string | null }>("/admin/status")]);
            setHosts(providers.hosts.join("\n")); setAdminStatus(status); setAdminOpen(true);
        } catch (error) { message.error((error as Error).message); }
    };

    if (session && roomId && meta && !invite) return <CollaborationBoard key={roomId} roomId={roomId} meta={meta} onBack={() => navigate("/collaboration")} />;

    return (
        <main className="min-h-dvh overflow-auto" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <div className="mx-auto max-w-5xl px-6 py-10">
                <header className="mb-12 flex flex-wrap items-center justify-between gap-4 border-b pb-6" style={{ borderColor: theme.node.stroke }}>
                    <div><p className="mb-2 flex items-center gap-2 text-xs opacity-65"><Users className="size-4" />无限画布 · 多人协作</p><h1 className="text-3xl font-semibold">协作空间</h1></div>
                    {session && <Space wrap><span className="mr-2 text-sm">{session.user.username}</span>{session.user.admin && <Button type="text" onClick={() => void openAdmin()}>服务管理</Button>}<Button type="text" onClick={() => setPasswordOpen(true)}>修改密码</Button><Button type="text" icon={<LogOut className="size-4" />} onClick={() => void logout()}>退出登录</Button></Space>}
                </header>
                {error && <Alert type="error" title={error} className="mb-6" />}
                {loading ? <p>正在连接协作服务…</p> : !session ? <div className="mx-auto max-w-md">
                    <h2 className="mb-3 text-xl font-medium">{register ? "接受邀请并注册" : "登录协作账户"}</h2>
                    <p className="mb-6 text-sm opacity-65">每人使用自己的账户。共享画布实时同步，隐私节点仅创建者可见。</p>
                    {!meta && <Button className="mb-4" onClick={() => window.location.reload()}>重新连接服务器</Button>}
                    <Form key={register ? "register" : "login"} layout="vertical" onFinish={authenticate}>
                        <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item>
                        <Form.Item name="password" label="密码" rules={[{ required: true }, { min: 12, message: "密码至少 12 个字符" }]}><Input.Password autoComplete={register ? "new-password" : "current-password"} /></Form.Item>
                        {register && <Form.Item name="invitePassword" label="分享口令（若邀请人设置了口令）"><Input.Password autoComplete="off" /></Form.Item>}
                        <Button type="primary" htmlType="submit" loading={busy} disabled={!meta} block>{register ? "注册并加入画布" : "登录"}</Button>
                    </Form>
                    {invite ? <Button type="text" className="mt-4" onClick={() => setRegister(!register)}>{register ? "已有账户，去登录" : "还没有账户，接受邀请注册"}</Button> : <p className="mt-5 text-xs opacity-60">新成员需通过画布所有者的分享链接注册。</p>}
                </div> : invite ? <div className="mx-auto max-w-md space-y-4"><h2 className="text-xl font-medium">你收到一份画布邀请</h2><Input.Password aria-label="分享口令" placeholder="分享口令（未设置时留空）" value={invitePassword} onChange={(event) => setInvitePassword(event.target.value)} /><Space><Button type="primary" loading={busy} onClick={() => void join()}>接受邀请</Button><Button onClick={() => { setInvite(""); invitation = ""; }}>暂不加入</Button></Space></div> : <>
                    <div className="mb-6 flex items-center justify-between"><p className="text-sm opacity-65">选择画布，与团队一起创作。</p><Button icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>创建协作画布</Button></div>
                    {!rooms.length ? <div className="py-24 text-center opacity-60">还没有协作画布。创建一个，或打开别人发来的邀请链接。</div> : <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{rooms.map((room) => <button key={room.id} className="rounded-xl border p-6 text-left transition hover:opacity-75" style={{ borderColor: theme.node.stroke, background: theme.node.panel }} onClick={() => navigate(`/collaboration/${room.id}`)}><Users className="mb-5 size-6 opacity-60" /><h2 className="truncate text-lg font-medium">{room.title}</h2><p className="mt-2 text-xs opacity-60">{room.role === "owner" ? "我的画布" : room.role === "editor" ? "可以编辑" : "仅可查看"}</p></button>)}</div>}
                    <p className="mt-12 flex items-center gap-2 text-xs opacity-60"><LockKeyhole className="size-4" />隐私内容与协作内容分开保存，API 返回结果不会自动共享。</p>
                </>}
            </div>
            <Modal open={createOpen} title="创建协作画布" onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
                <Form layout="vertical" onFinish={async ({ title }: { title: string }) => {
                    setBusy(true);
                    try { const room = await collaborationApi<SharedRoom>("/rooms", { method: "POST", body: JSON.stringify({ title }) }); setCreateOpen(false); navigate(`/collaboration/${room.id}`); }
                    catch (error) { message.error((error as Error).message); } finally { setBusy(false); }
                }}><Form.Item name="title" label="画布名称" rules={[{ required: true }]}><Input autoFocus /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>创建</Button></Form>
            </Modal>
            <Modal open={adminOpen} title="服务管理" onCancel={() => setAdminOpen(false)} footer={null} destroyOnHidden>
                <p className="mb-3 text-sm">允许隐私节点访问的 API 域名，每行一个。只填写可信服务商的域名，所有请求仍会检查目标 IP。</p>
                <Input.TextArea aria-label="允许的 API 域名" value={hosts} onChange={(event) => setHosts(event.target.value)} autoSize={{ minRows: 5 }} placeholder="api.example.com" />
                <Button className="mt-3" onClick={async () => { try { await collaborationApi("/admin/providers", { method: "PUT", body: JSON.stringify({ hosts: hosts.split(/[\s,]+/).filter(Boolean) }) }); message.success("API 域名已保存"); } catch (error) { message.error((error as Error).message); } }}>保存 API 域名</Button>
                <p className="mb-3 mt-6 text-sm">最近云盘备份：{adminStatus?.lastBackup ? new Date(adminStatus.lastBackup.createdAt).toLocaleString() : "尚未完成"}</p>
                {adminStatus?.backupError && <Alert type="error" title={adminStatus.backupError} className="mb-3" />}
                <Button loading={busy} onClick={async () => { setBusy(true); try { await collaborationApi("/admin/backup", { method: "POST" }); await openAdmin(); message.success("加密备份已完成"); } catch (error) { message.error((error as Error).message); } finally { setBusy(false); } }}>立即加密备份</Button>
            </Modal>
            <Modal open={passwordOpen} title="修改登录密码" onCancel={() => setPasswordOpen(false)} footer={null} destroyOnHidden>
                <Form layout="vertical" onFinish={async (values: { oldPassword: string; newPassword: string }) => { setBusy(true); try { const data = await collaborationApi<CollaborationSession>("/auth/password", { method: "POST", body: JSON.stringify(values) }); acceptSession(data); setPasswordOpen(false); message.success("密码已更新，其他登录已失效"); } catch (error) { message.error((error as Error).message); } finally { setBusy(false); } }}>
                    <Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 12, message: "至少 12 个字符" }]}><Input.Password autoComplete="new-password" /></Form.Item><Button htmlType="submit" loading={busy}>保存新密码</Button>
                </Form>
            </Modal>
        </main>
    );
}
