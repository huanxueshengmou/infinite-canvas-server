import { useRef, useState } from "react";
import { Grip } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { NodeFields, SharedNode } from "@/services/api/collaboration";
import { DrawingSurface, DrawingToolbar } from "./drawing-surface";
import { initialDrawingSettings } from "./drawing";

export function WhiteboardNode({ node, editable, selected, scale, onEdit, onBegin, onEnd }: {
    node: SharedNode; editable: boolean; selected: boolean; scale: number; onEdit: (fields: NodeFields) => void; onBegin: () => void; onEnd: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [settings, setSettings] = useState({ ...initialDrawingSettings, color: "currentColor" });
    const resize = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null);
    return <><div data-canvas-no-zoom className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl" style={{ color: theme.node.text }}>
        <DrawingSurface width={node.width} height={Math.max(1, node.height - 44)} drawing={node.drawing || []} settings={settings} disabled={!editable} onAdd={(mark) => { onBegin(); onEdit({ drawing: [...(node.drawing || []), mark] }); onEnd(); }} />
        {!node.drawing?.length && <span className="pointer-events-none absolute left-4 top-4 text-sm opacity-40">在白板上手写，或选择文本后点击放置</span>}
        {editable && selected && <div className="absolute inset-x-2 bottom-7 rounded-lg border p-1.5" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}><DrawingToolbar value={settings} onChange={setSettings} /></div>}
        </div>
        {editable && <button type="button" aria-label="调整白板大小" title={`${Math.round(node.width)} × ${Math.round(node.height)}`} className="absolute bottom-0 right-0 z-10 flex size-6 cursor-se-resize touch-none items-center justify-center" onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation(); onBegin();
            resize.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: node.width, height: node.height };
            event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={(event) => {
            const start = resize.current;
            if (start?.pointerId === event.pointerId) onEdit({ width: Math.max(1, start.width + (event.clientX - start.x) / scale), height: Math.max(1, start.height + (event.clientY - start.y) / scale) });
        }} onPointerUp={(event) => { if (resize.current) { resize.current = null; onEnd(); } if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { if (resize.current) { resize.current = null; onEnd(); } }} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); onBegin();
            onEdit({ width: Math.max(1, node.width + (event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0)), height: Math.max(1, node.height + (event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0)) }); onEnd();
        }}><Grip className="size-4 opacity-60" /></button>}
    </>;
}
