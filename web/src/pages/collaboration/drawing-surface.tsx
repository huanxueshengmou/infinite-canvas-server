import { useRef, useState, type PointerEvent } from "react";
import { App, Button, Input, InputNumber, Tooltip } from "antd";
import { ArrowUpRight, Brush, Crop, Type } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { DrawingItem, DrawingPoint } from "@/services/api/collaboration";
import { arrowLines, cropBetween, textLines, type CropRect, type DrawingSettings } from "./drawing";

export function DrawingToolbar({ value, onChange, crop = false, disabled = false }: { value: DrawingSettings; onChange: (value: DrawingSettings) => void; crop?: boolean; disabled?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const tools = [{ tool: "brush", label: "画笔", icon: Brush }, { tool: "arrow", label: "箭头", icon: ArrowUpRight }, { tool: "text", label: "文本", icon: Type }, ...(crop ? [{ tool: "crop", label: "框选裁剪", icon: Crop }] : [])] as const;
    return <div data-canvas-no-zoom className="flex flex-wrap items-center gap-1">
        {tools.map(({ tool, label, icon: Icon }) => <Button key={tool} type="text" size="small" aria-label={label} aria-pressed={value.tool === tool} disabled={disabled} style={value.tool === tool ? { background: theme.toolbar.activeBg } : undefined} icon={<Icon className="size-4" />} onClick={() => onChange({ ...value, tool: tool as DrawingSettings["tool"] })}>{label}</Button>)}
        <Tooltip title="笔迹颜色"><input type="color" aria-label="笔迹颜色" className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0" disabled={disabled} value={value.color === "currentColor" ? theme.node.text : value.color} onChange={(event) => onChange({ ...value, color: event.target.value })} /></Tooltip>
        <InputNumber aria-label={value.tool === "text" ? "字号" : "画笔粗细"} size="small" className="!w-20" min={1} value={value.tool === "text" ? value.fontSize : value.size} disabled={disabled || value.tool === "crop"} onChange={(size) => { if (size && Number.isFinite(size)) onChange({ ...value, [value.tool === "text" ? "fontSize" : "size"]: size }); }} />
        {value.tool === "text" && <Input.TextArea aria-label="绘图文本" autoSize={{ minRows: 1 }} className="!mt-1 !w-full" placeholder="输入文字，然后点击绘图区域放置" disabled={disabled} value={value.text} onChange={(event) => onChange({ ...value, text: event.target.value })} />}
    </div>;
}

export function Marks({ drawing }: { drawing: DrawingItem[] }) {
    return <g pointerEvents="none">{drawing.map((mark, index) => mark.type === "text" ? <text key={index} data-drawing-type="text" fill={mark.color} fontSize={mark.size} fontFamily="sans-serif">{textLines(mark).map((line, i) => <tspan key={i} x={line.x} y={line.y}>{line.text}</tspan>)}</text> : <g key={index} data-drawing-type={mark.type} fill="none" stroke={mark.color} strokeWidth={mark.size} strokeLinecap="round" strokeLinejoin="round">
        {mark.type === "brush" && mark.points.length === 1 ? <circle cx={mark.points[0].x} cy={mark.points[0].y} r={mark.size / 2} fill={mark.color} stroke="none" /> : (mark.type === "brush" ? [mark.points] : arrowLines(mark)).map((points, i) => <polyline key={i} points={points.map((point) => `${point.x},${point.y}`).join(" ")} />)}
    </g>)}</g>;
}

export function DrawingSurface({ width, height, drawing, settings, disabled = false, crop, onAdd, onCrop }: {
    width: number; height: number; drawing: DrawingItem[]; settings: DrawingSettings; disabled?: boolean; crop?: CropRect | null;
    onAdd: (mark: DrawingItem) => void; onCrop?: (rect: CropRect) => void;
}) {
    const { message } = App.useApp();
    const active = useRef<{ pointerId: number; start: DrawingPoint; mark: DrawingItem | null } | null>(null);
    const [preview, setPreview] = useState<DrawingItem | null>(null), [cropPreview, setCropPreview] = useState<CropRect | null>(null);
    const point = (event: PointerEvent<SVGSVGElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        return { x: Math.max(0, Math.min(width, (event.clientX - box.left) * width / box.width)), y: Math.max(0, Math.min(height, (event.clientY - box.top) * height / box.height)) };
    };
    const move = (event: PointerEvent<SVGSVGElement>) => {
        const current = active.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const next = point(event);
        if (!current.mark) setCropPreview(cropBetween(current.start, next));
        else if (current.mark.type === "brush") { current.mark = { ...current.mark, points: [...current.mark.points, next] }; setPreview(current.mark); }
        else if (current.mark.type === "arrow") { current.mark = { ...current.mark, to: next }; setPreview(current.mark); }
    };
    const reset = (event: PointerEvent<SVGSVGElement>) => { active.current = null; setPreview(null); setCropPreview(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
    const selection = cropPreview || crop;
    return <svg data-canvas-no-zoom data-drawing-surface aria-label="绘图区域" className={`absolute inset-0 h-full w-full touch-none select-none ${disabled ? "" : "cursor-crosshair"}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerDown={(event) => {
        if (disabled || event.button !== 0 || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); event.stopPropagation();
        const start = point(event), style = { color: settings.color, size: settings.size };
        if (settings.tool === "text") {
            if (!settings.text.trim()) { message.info("请先输入要放置的文字"); return; }
            onAdd({ type: "text", position: start, text: settings.text, color: settings.color, size: settings.fontSize }); return;
        }
        const mark: DrawingItem | null = settings.tool === "brush" ? { type: "brush", points: [start], ...style } : settings.tool === "arrow" ? { type: "arrow", from: start, to: start, ...style } : null;
        active.current = { pointerId: event.pointerId, start, mark }; setPreview(mark);
        event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={move} onPointerUp={(event) => {
        const current = active.current;
        if (!current || current.pointerId !== event.pointerId) return;
        move(event);
        if (active.current?.mark) onAdd(active.current.mark);
        else { const rect = cropBetween(current.start, point(event)); if (rect.width >= 1 && rect.height >= 1) onCrop?.(rect); }
        reset(event);
    }} onPointerCancel={reset} onLostPointerCapture={() => { active.current = null; setPreview(null); setCropPreview(null); }}>
        <Marks drawing={preview ? [...drawing, preview] : drawing} />
        {selection && <g pointerEvents="none"><path fill="currentColor" opacity={0.18} fillRule="evenodd" d={`M0 0H${width}V${height}H0Z M${selection.x} ${selection.y}h${selection.width}v${selection.height}h-${selection.width}Z`} /><rect data-crop-selection x={selection.x} y={selection.y} width={selection.width} height={selection.height} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" /></g>}
    </svg>;
}
