export type CollaborationUser = { id: string; username: string; admin: boolean };
export type CollaborationSession = { user: CollaborationUser; csrf: string; expiresAt: number };
export type CollaborationRole = "owner" | "editor" | "viewer";
export type SharedNode = {
    id: string;
    kind: "text" | "image" | "file" | "private";
    position: { x: number; y: number };
    width: number;
    height: number;
    title: string;
    content: string;
    fileId: string | null;
    version: number;
};
export type SharedRoom = { id: string; title: string; role: CollaborationRole; revision?: number };
export type PrivateData = {
    title: string;
    note: string;
    request: { url: string; method: "GET" | "POST"; apiKey: string; header: "Authorization" | "x-api-key"; body: string };
};
export type PrivateRecord = { data: PrivateData; version: number; result: { status: number; text: string } | null };
export type NodeFields = Partial<Pick<SharedNode, "position" | "width" | "height" | "title" | "content" | "fileId">>;
export type NodeOperation =
    | { type: "create"; node: Omit<SharedNode, "version"> & { privateData?: PrivateData } }
    | { type: "update"; id: string; version: number; fields: NodeFields }
    | { type: "delete"; id: string; version: number };
export type ChangeEvent = { type: "changes"; operationId: string; revision: number; changes: ({ type: "upsert"; node: SharedNode } | { type: "delete"; id: string })[] };
export type CollaborationMeta = { maxRoomConnections: number; maxSyncBytes: number; maxFileBytes: number; syncBatchMs: number; shareTtlMs: number; apiTimeoutMs: number };

export class CollaborationError extends Error {
    constructor(message: string, public status: number, public details?: { node?: SharedNode; nodeId?: string; deleted?: boolean }) {
        super(message);
    }
}

// Session credentials and all private records remain in memory; cookies are HttpOnly.
let session: CollaborationSession | null = null;
export const setCollaborationSession = (value: CollaborationSession | null) => { session = value; };

export async function collaborationApi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
    if (session && init.method && !["GET", "HEAD"].includes(init.method)) headers.set("X-CSRF-Token", session.csrf);
    const response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({ error: "协作服务不可用，请检查服务器连接" }));
    if (!response.ok) throw new CollaborationError(data.error || "请求失败", response.status, data.details);
    return data as T;
}

export const emptyPrivateData = (): PrivateData => ({ title: "我的隐私节点", note: "", request: { url: "", method: "POST", apiKey: "", header: "Authorization", body: '{\n  "model": "",\n  "messages": []\n}' } });
export const collaborationFileUrl = (roomId: string, id: string) => `/api/rooms/${roomId}/files/${id}`;
