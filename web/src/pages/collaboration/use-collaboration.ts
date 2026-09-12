import { useCallback, useEffect, useRef, useState } from "react";
import { collaborationApi, CollaborationError, COLLABORATION_PROTOCOL, type ChangeEvent, type CollaborationMeta, type CollaborationCursor, type NodeFields, type NodeOperation, type SharedNode, type SharedRoom, type SharedEdge } from "@/services/api/collaboration";

type Draft = { base: SharedNode; fields: NodeFields; historyId: string; conflict?: boolean };
type HistoryEntry = { id: string; nodes: Set<string>; edges: Set<string> };
type HistoryRequest = { entry: HistoryEntry; direction: "undo" | "redo"; body: { operationId: string; direction: "undo" | "redo"; nodes: Record<string, number | null>; edges: Record<string, number | null> } };
type LocalOperation = { privateIds?: string[]; history?: HistoryRequest };
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
    const pendingRequest = useRef<{ operationId: string; historyId: string; operations: NodeOperation[] } | null>(null);
    const localOperations = useRef(new Map<string, LocalOperation>());
    const requests = useRef(new Set<Promise<unknown>>());
    const undoStack = useRef<HistoryEntry[]>([]), redoStack = useRef<HistoryEntry[]>([]);
    const pendingHistory = useRef<HistoryRequest | null>(null);
    const editingGroup = useRef<string | null>(null);
    const historyBusy = useRef(false);
    const [history, setHistory] = useState({ canUndo: false, canRedo: false, busy: false });
    const flightDone = useRef<Promise<void>>(Promise.resolve());
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnect = useRef<() => void>(() => {});
    const deniedRef = useRef(onDenied);
    deniedRef.current = onDenied;

    const render = useCallback(() => {
        setNodes([...canonical.current.values()].map((node) => ({ ...node, ...drafts.current.get(node.id)?.fields })));
        setEdges([...canonicalEdges.current.values()]);
        setHistory({ canUndo: undoStack.current.length > 0 || pendingHistory.current?.direction === "undo", canRedo: redoStack.current.length > 0 || pendingHistory.current?.direction === "redo", busy: historyBusy.current });
        const conflicts = [...drafts.current].filter(([, value]) => value.conflict).map(([id]) => id);
        setConflicts(conflicts);
        if (!ready.current) return;
        setState(conflicts.length ? "conflict" : drafts.current.size || inFlight.current ? "pending" : "synced");
    }, []);

    const apply = useCallback((event: ChangeEvent) => {
        if (event.revision <= revision.current) return;
        if (event.revision !== revision.current + 1) { ready.current = false; reconnect.current(); return; }
        const local = localOperations.current.get(event.operationId);
        const changedNodes = new Set<string>(), changedEdges = new Set<string>();
        for (const change of event.changes) {
            if (change.type === "edge-upsert" || change.type === "edge-delete") {
                const edge = change.type === "edge-upsert" ? change.edge : canonicalEdges.current.get(change.id);
                changedEdges.add(change.type === "edge-upsert" ? change.edge.id : change.id);
                if (edge) { changedNodes.add(edge.source); changedNodes.add(edge.target); }
            } else changedNodes.add(change.type === "upsert" ? change.node.id : change.id);
        }
        if (!local) {
            const unaffected = (entry: HistoryEntry) => ![...entry.nodes].some((id) => changedNodes.has(id)) && ![...entry.edges].some((id) => changedEdges.has(id));
            undoStack.current = undoStack.current.filter(unaffected); redoStack.current = redoStack.current.filter(unaffected);
        } else if (local.history) {
            const { entry, direction } = local.history;
            const from = direction === "undo" ? undoStack : redoStack, to = direction === "undo" ? redoStack : undoStack;
            if (from.current.includes(entry)) { from.current = from.current.filter((item) => item !== entry); to.current.push(entry); }
        } else if (event.historyId) {
            let entry = undoStack.current.at(-1);
            if (entry?.id !== event.historyId) { entry = { id: event.historyId, nodes: new Set(), edges: new Set() }; undoStack.current.push(entry); }
            for (const change of event.changes) {
                if (change.type === "edge-upsert" || change.type === "edge-delete") entry.edges.add(change.type === "edge-upsert" ? change.edge.id : change.id);
                else entry.nodes.add(change.type === "upsert" ? change.node.id : change.id);
            }
            redoStack.current = [];
        }
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
        setOwnPrivateIds((ids) => new Set([...ids, ...(local?.privateIds || [])].filter((id) => canonical.current.has(id))));
        render();
    }, [render]);

    const flush = useCallback(async (): Promise<boolean> => {
        if (!alive.current || !ready.current || readOnly.current) return false;
        if (inFlight.current) { await flightDone.current; return flush(); }
        const available = [...drafts.current].filter(([, draft]) => !draft.conflict && Object.keys(draft.fields).length);
        const entries = available.filter(([, draft]) => draft.historyId === available[0]?.[1].historyId);
        if (!entries.length && !pendingRequest.current) return true;
        // Retry the same operation id after ambiguous network failures; the server deduplicates it.
        const batch = pendingRequest.current || {
            operationId: crypto.randomUUID(),
            historyId: entries[0][1].historyId,
            operations: entries.map(([id, draft]) => ({ type: "update" as const, id, version: draft.base.version, fields: structuredClone(draft.fields) })),
        };
        if (new TextEncoder().encode(JSON.stringify(batch)).length > meta.maxSyncBytes) {
            setError("待同步内容超过单次同步限制，请缩小文本后重试；草稿仍保留在当前页面。");
            setState("conflict");
            return false;
        }
        pendingRequest.current = batch;
        inFlight.current = true;
        let finishFlight!: () => void;
        flightDone.current = new Promise<void>((resolve) => { finishFlight = resolve; });
        localOperations.current.set(batch.operationId, {});
        let succeeded = false;
        setState("pending");
        try {
            const event = await collaborationApi<ChangeEvent>(`/rooms/${roomId}/operations`, { method: "POST", body: JSON.stringify(batch) });
            if (!alive.current) return false;
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
            succeeded = true;
        } catch (error) {
            if (!alive.current) return false;
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
            finishFlight();
            if (!pendingRequest.current) localOperations.current.delete(batch.operationId);
            if (alive.current) {
                render();
                if (ready.current && [...drafts.current.values()].some((draft) => !draft.conflict)) timer.current = setTimeout(() => void flush(), meta.syncBatchMs);
            }
        }
        return succeeded;
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
            undoStack.current = []; redoStack.current = []; pendingHistory.current = null;
            setHistory({ canUndo: false, canRedo: false, busy: false });
            setState("connecting");
            const url = new URL(`/api/rooms/${roomId}/events`, window.location.origin);
            url.searchParams.set("v", COLLABORATION_PROTOCOL);
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
                undoStack.current = []; redoStack.current = []; pendingHistory.current = null;
                setHistory({ canUndo: false, canRedo: false, busy: false });
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
            undoStack.current = []; redoStack.current = []; localOperations.current.clear(); pendingHistory.current = null;
            window.removeEventListener("beforeunload", warn);
        };
    }, [apply, flush, meta.apiTimeoutMs, meta.syncBatchMs, render, roomId]);

    const editMany = useCallback((edits: { id: string; fields: NodeFields }[], group?: string) => {
        if (readOnly.current || historyBusy.current || pendingHistory.current) return;
        const historyId = group || editingGroup.current || crypto.randomUUID();
        for (const { id, fields } of edits) {
            const node = canonical.current.get(id);
            if (!node) continue;
            const existing = drafts.current.get(id);
            drafts.current.set(id, { base: existing?.base || node, fields: { ...existing?.fields, ...fields }, historyId: existing?.historyId || historyId, conflict: existing?.conflict });
        }
        render();
        if (!timer.current) timer.current = setTimeout(() => { timer.current = null; void flush(); }, meta.syncBatchMs);
    }, [flush, meta.syncBatchMs, render]);

    const settle = useCallback(async () => {
        if (requests.current.size) await Promise.all([...requests.current]);
        do {
            if ([...drafts.current.values()].some((draft) => draft.conflict)) throw new Error("请先处理编辑冲突，再执行这项操作");
            if (!await flush()) throw new Error("请等待连接恢复或处理未同步内容");
        } while (drafts.current.size || inFlight.current);
    }, [flush]);

    const mutate = useCallback(async (operations: NodeOperation[]) => {
        if (!ready.current || readOnly.current) throw new Error("请等待连接恢复并确认编辑权限");
        if (historyBusy.current || pendingHistory.current) throw new Error("请先等待撤销 / 重做结果确认");
        const changed = new Set(drafts.current.keys());
        await settle();
        const batch = { operationId: crypto.randomUUID(), operations: operations.map((operation) => (operation.type === "update" || operation.type === "delete") && changed.has(operation.id) ? { ...operation, version: canonical.current.get(operation.id)?.version || operation.version } : operation) };
        const privateIds = operations.filter((operation) => operation.type === "create" && operation.node.kind === "private").map((operation) => operation.type === "create" ? operation.node.id : "");
        localOperations.current.set(batch.operationId, { privateIds });
        const request = collaborationApi<ChangeEvent>(`/rooms/${roomId}/operations`, { method: "POST", body: JSON.stringify(batch) });
        requests.current.add(request);
        try { const result = await request; if (alive.current) apply(result); return result; }
        finally { requests.current.delete(request); localOperations.current.delete(batch.operationId); }
    }, [apply, roomId, settle]);

    const changeHistory = useCallback(async (direction: "undo" | "redo") => {
        if (historyBusy.current) return;
        if (!ready.current || readOnly.current) throw new Error("撤销 / 重做需要在线编辑权限");
        historyBusy.current = true; render();
        try {
            await settle();
            const entry = (direction === "undo" ? undoStack : redoStack).current.at(-1);
            if (!entry && !pendingHistory.current) return;
            const action = pendingHistory.current || { entry: entry!, direction, body: {
                operationId: crypto.randomUUID(), direction,
                nodes: Object.fromEntries([...entry!.nodes].map((id) => [id, canonical.current.get(id)?.version ?? null])),
                edges: Object.fromEntries([...entry!.edges].map((id) => [id, canonicalEdges.current.get(id)?.version ?? null])),
            } };
            pendingHistory.current = action;
            localOperations.current.set(action.body.operationId, { history: action });
            const result = await collaborationApi<{ event: ChangeEvent; ownPrivateIds: string[] }>(`/rooms/${roomId}/history/${action.entry.id}`, { method: "POST", body: JSON.stringify(action.body) });
            if (alive.current && ready.current) { apply(result.event); setOwnPrivateIds(new Set(result.ownPrivateIds)); }
            localOperations.current.delete(action.body.operationId); pendingHistory.current = null;
        } catch (error) {
            if (error instanceof CollaborationError && error.status < 500 && pendingHistory.current) {
                const pending = pendingHistory.current;
                undoStack.current = undoStack.current.filter((entry) => entry !== pending.entry); redoStack.current = redoStack.current.filter((entry) => entry !== pending.entry);
                localOperations.current.delete(pending.body.operationId); pendingHistory.current = null;
            }
            throw error;
        } finally { historyBusy.current = false; if (alive.current) render(); }
    }, [apply, render, roomId, settle]);

    const resolveConflict = (id: string, keep: boolean) => {
        const draft = drafts.current.get(id), current = canonical.current.get(id);
        if (keep && draft && current) drafts.current.set(id, { base: current, fields: draft.fields, historyId: crypto.randomUUID() });
        else drafts.current.delete(id);
        render();
        void flush();
    };
    const setCursor = (position: CollaborationCursor["position"] | null) => { cursor.current = position; cursorDirty.current = true; };
    return { room, nodes, edges, ownPrivateIds, state, error, online, cursors, setCursor, conflicts, edit: (id: string, fields: NodeFields) => editMany([{ id, fields }]), editMany, mutate, history, changeHistory,
        beginEditing: () => { editingGroup.current = crypto.randomUUID(); }, endEditing: () => { editingGroup.current = null; void flush(); }, reconnect: () => reconnect.current(),
        resolveConflict, getDraft: (id: string) => drafts.current.get(id), canEdit: room?.role !== "viewer" && !history.busy && !["connecting", "denied"].includes(state) };
}
