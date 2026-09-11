import { useCallback, useEffect, useRef, useState } from "react";
import { collaborationApi, CollaborationError, type ChangeEvent, type CollaborationMeta, type CollaborationCursor, type NodeFields, type NodeOperation, type SharedNode, type SharedRoom, type SharedEdge } from "@/services/api/collaboration";

type Draft = { base: SharedNode; fields: NodeFields; conflict?: boolean };
type SyncState = "connecting" | "synced" | "pending" | "offline" | "denied" | "conflict";

export function useCollaboration(roomId: string, meta: CollaborationMeta, onDenied: () => void) {
    const [room, setRoom] = useState<SharedRoom | null>(null);
    const [nodes, setNodes] = useState<SharedNode[]>([]);
    const [edges, setEdges] = useState<SharedEdge[]>([]);
    const canonicalEdges = useRef(new Map<string, SharedEdge>());
    const [ownPrivateIds, setOwnPrivateIds] = useState<Set<string>>(new Set());
    const [state, setState] = useState<SyncState>("connecting");
    const [error, setError] = useState("");
    const [online, setOnline] = useState(0);
    const [cursors, setCursors] = useState<CollaborationCursor[]>([]);
    const cursor = useRef<CollaborationCursor["position"] | null>(null);
    const cursorDirty = useRef(false);
    const [conflicts, setConflicts] = useState<string[]>([]);
    const canonical = useRef(new Map<string, SharedNode>());
    const drafts = useRef(new Map<string, Draft>());
    const revision = useRef(0);
    const ready = useRef(false);
    const readOnly = useRef(true);
    const alive = useRef(true);
    const inFlight = useRef(false);
    const pendingRequest = useRef<{ operationId: string; operations: NodeOperation[] } | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnect = useRef<() => void>(() => {});
    const deniedRef = useRef(onDenied);
    deniedRef.current = onDenied;

    const render = useCallback(() => {
        setNodes([...canonical.current.values()].map((node) => ({ ...node, ...drafts.current.get(node.id)?.fields })));
        setEdges([...canonicalEdges.current.values()]);
        const conflicts = [...drafts.current].filter(([, value]) => value.conflict).map(([id]) => id);
        setConflicts(conflicts);
        if (!ready.current) return;
        setState(conflicts.length ? "conflict" : drafts.current.size || inFlight.current ? "pending" : "synced");
    }, []);

    const apply = useCallback((event: ChangeEvent) => {
        if (event.revision <= revision.current) return;
        if (event.revision !== revision.current + 1) { ready.current = false; reconnect.current(); return; }
        for (const change of event.changes) {
            if (change.type === "edge-upsert") canonicalEdges.current.set(change.edge.id, change.edge);
            else if (change.type === "edge-delete") canonicalEdges.current.delete(change.id);
            else if (change.type === "delete") {
                canonical.current.delete(change.id);
                const draft = drafts.current.get(change.id);
                if (draft) draft.conflict = true;
            } else canonical.current.set(change.node.id, change.node);
        }
        revision.current = event.revision;
        render();
    }, [render]);

    const flush = useCallback(async () => {
        if (!alive.current || !ready.current || readOnly.current || inFlight.current) return;
        const entries = [...drafts.current].filter(([, draft]) => !draft.conflict && Object.keys(draft.fields).length);
        if (!entries.length && !pendingRequest.current) return;
        // Retry the same operation id after ambiguous network failures; the server deduplicates it.
        const batch = pendingRequest.current || {
            operationId: crypto.randomUUID(),
            operations: entries.map(([id, draft]) => ({ type: "update" as const, id, version: draft.base.version, fields: structuredClone(draft.fields) })),
        };
        if (new TextEncoder().encode(JSON.stringify(batch)).length > meta.maxSyncBytes) {
            setError("待同步内容超过单次同步限制，请缩小文本后重试；草稿仍保留在当前页面。");
            setState("conflict");
            return;
        }
        pendingRequest.current = batch;
        inFlight.current = true;
        setState("pending");
        try {
            const event = await collaborationApi<ChangeEvent>(`/rooms/${roomId}/operations`, { method: "POST", body: JSON.stringify(batch) });
            if (!alive.current) return;
            apply(event);
            for (const operation of batch.operations) {
                if (operation.type !== "update") continue;
                const draft = drafts.current.get(operation.id);
                if (!draft) continue;
                for (const field of Object.keys(operation.fields) as (keyof NodeFields)[]) {
                    if (JSON.stringify(draft.fields[field]) === JSON.stringify(operation.fields[field])) delete draft.fields[field];
                }
                const latest = canonical.current.get(operation.id);
                if (latest) draft.base = latest;
                if (!Object.keys(draft.fields).length) drafts.current.delete(operation.id);
            }
            pendingRequest.current = null;
            setError("");
        } catch (error) {
            if (!alive.current) return;
            if (error instanceof CollaborationError && error.status === 409) {
                pendingRequest.current = null;
                for (const operation of batch.operations) {
                    if (operation.type !== "update") continue;
                    const draft = drafts.current.get(operation.id);
                    if (draft) draft.conflict = true;
                }
            } else if (error instanceof CollaborationError && [401, 403, 404].includes(error.status)) {
                ready.current = false;
                canonical.current.clear();
                canonicalEdges.current.clear(); setEdges([]);
                drafts.current.clear();
                pendingRequest.current = null;
                setNodes([]);
                setOwnPrivateIds(new Set());
                setState("denied");
                deniedRef.current();
            } else if (error instanceof CollaborationError && error.status < 500) {
                pendingRequest.current = null;
                for (const operation of batch.operations) {
                    if (operation.type === "update") { const draft = drafts.current.get(operation.id); if (draft) draft.conflict = true; }
                }
            } else { ready.current = false; setState("offline"); }
            setError(error instanceof Error ? error.message : "同步失败，草稿仍保留在当前页面");
        } finally {
            inFlight.current = false;
            if (alive.current) {
                render();
                if (ready.current && [...drafts.current.values()].some((draft) => !draft.conflict)) timer.current = setTimeout(() => void flush(), meta.syncBatchMs);
            }
        }
    }, [apply, meta.maxSyncBytes, meta.syncBatchMs, render, roomId]);

    useEffect(() => {
        alive.current = true;
        let socket: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;
        let generation = 0;
        let userId = "";
        const sendCursor = () => {
            if (cursorDirty.current && ready.current && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "cursor", position: cursor.current }));
                cursorDirty.current = false;
            }
        };
        const cursorTimer = setInterval(sendCursor, meta.syncBatchMs);
        const hideCursor = () => { cursor.current = null; cursorDirty.current = true; sendCursor(); };
        const visibilityChanged = () => { if (document.visibilityState === "hidden") hideCursor(); };
        document.addEventListener("visibilitychange", visibilityChanged);
        window.addEventListener("blur", hideCursor);
        const connect = () => {
            if (!alive.current) return;
            const currentGeneration = ++generation;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            socket?.close();
            ready.current = false;
            setState("connecting");
            const url = new URL(`/api/rooms/${roomId}/events`, window.location.origin);
            url.searchParams.set("v", "2");
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            socket = new WebSocket(url);
            const snapshot = new Map<string, SharedNode>();
            const edgeSnapshot = new Map<string, SharedEdge>();
            const owned = new Set<string>();
            socket.onmessage = (message) => {
                if (!alive.current || currentGeneration !== generation) return;
                let event;
                try { event = JSON.parse(message.data); } catch { socket?.close(); return; }
                if (event.type === "snapshot-start") { setRoom(event.room); userId = event.userId; readOnly.current = event.room.role === "viewer"; }
                else if (event.type === "snapshot-node") { snapshot.set(event.node.id, event.node); if (event.ownPrivate) owned.add(event.node.id); }
                else if (event.type === "snapshot-edge") edgeSnapshot.set(event.edge.id, event.edge);
                else if (event.type === "snapshot-end") {
                    canonical.current = snapshot;
                    canonicalEdges.current = edgeSnapshot;
                    revision.current = event.revision;
                    setOwnPrivateIds(owned);
                    for (const [id, draft] of drafts.current) {
                        const current = snapshot.get(id);
                        if (!current || current.version !== draft.base.version) draft.conflict = true;
                    }
                    ready.current = true;
                    cursorDirty.current = true;
                    attempt = 0;
                    setError("");
                    render();
                    void flush();
                } else if (event.type === "changes") apply(event);
                else if (event.type === "presence") setOnline(event.count);
                else if (event.type === "cursors") setCursors((event.cursors as CollaborationCursor[]).filter((cursor) => cursor.userId !== userId));
            };
            socket.onclose = async (event) => {
                if (!alive.current || currentGeneration !== generation) return;
                ready.current = false;
                setOnline(0);
                setCursors([]);
                // Clear private panels as soon as an authenticated connection disappears.
                deniedRef.current();
                if (event.code === 4001) {
                    canonical.current.clear(); drafts.current.clear(); pendingRequest.current = null;
                    canonicalEdges.current.clear(); setEdges([]);
                    setNodes([]); setOwnPrivateIds(new Set()); setState("denied");
                    setError(event.reason.includes("刷新") ? event.reason : "登录、分享或成员权限已改变，请重新连接验证。");
                    return;
                }
                setState("offline");
                try { await collaborationApi(`/rooms/${roomId}`); }
                catch (error) {
                    if (error instanceof CollaborationError && [401, 403, 404].includes(error.status)) {
                        canonical.current.clear(); drafts.current.clear(); setNodes([]); setOwnPrivateIds(new Set());
                        canonicalEdges.current.clear(); setEdges([]);
                        setState("denied"); setError(error.message); return;
                    }
                }
                if (!alive.current || currentGeneration !== generation) return;
                // Bounded backoff uses the approved batch interval and API timeout, avoiding reconnect storms.
                const delay = Math.min(meta.apiTimeoutMs, meta.syncBatchMs * 2 ** ++attempt);
                reconnectTimer = setTimeout(connect, delay);
            };
        };
        reconnect.current = connect;
        connect();
        const warn = (event: BeforeUnloadEvent) => { if (drafts.current.size || inFlight.current) event.preventDefault(); };
        window.addEventListener("beforeunload", warn);
        return () => {
            alive.current = false;
            generation++;
            if (timer.current) clearTimeout(timer.current);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            clearInterval(cursorTimer);
            document.removeEventListener("visibilitychange", visibilityChanged);
            window.removeEventListener("blur", hideCursor);
            socket?.close();
            canonical.current.clear(); drafts.current.clear(); pendingRequest.current = null;
            canonicalEdges.current.clear();
            window.removeEventListener("beforeunload", warn);
        };
    }, [apply, flush, meta.apiTimeoutMs, meta.syncBatchMs, render, roomId]);

    const edit = useCallback((id: string, fields: NodeFields) => {
        if (readOnly.current) return;
        const node = canonical.current.get(id);
        if (!node) return;
        const existing = drafts.current.get(id);
        drafts.current.set(id, { base: existing?.base || node, fields: { ...existing?.fields, ...fields }, conflict: existing?.conflict });
        render();
        if (!timer.current) timer.current = setTimeout(() => { timer.current = null; void flush(); }, meta.syncBatchMs);
    }, [flush, meta.syncBatchMs, render]);

    const mutate = useCallback(async (operations: NodeOperation[]) => {
        if (!ready.current || readOnly.current) throw new Error("请等待连接恢复并确认编辑权限");
        const batch = { operationId: crypto.randomUUID(), operations };
        const result = await collaborationApi<ChangeEvent>(`/rooms/${roomId}/operations`, { method: "POST", body: JSON.stringify(batch) });
        apply(result);
        const privateIds = operations.filter((operation) => operation.type === "create" && operation.node.kind === "private").map((operation) => operation.type === "create" ? operation.node.id : "");
        if (privateIds.length) setOwnPrivateIds((ids) => new Set([...ids, ...privateIds]));
        return result;
    }, [apply, roomId]);

    const resolveConflict = (id: string, keep: boolean) => {
        const draft = drafts.current.get(id), current = canonical.current.get(id);
        if (keep && draft && current) drafts.current.set(id, { base: current, fields: draft.fields });
        else drafts.current.delete(id);
        render();
        void flush();
    };
    const setCursor = (position: CollaborationCursor["position"] | null) => { cursor.current = position; cursorDirty.current = true; };
    return { room, nodes, edges, ownPrivateIds, state, error, online, cursors, setCursor, conflicts, edit, mutate, reconnect: () => reconnect.current(),
        resolveConflict, getDraft: (id: string) => drafts.current.get(id), canEdit: room?.role !== "viewer" && !["connecting", "denied"].includes(state) };
}
