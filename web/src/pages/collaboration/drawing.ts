import type { DrawingItem, DrawingPoint } from "@/services/api/collaboration";

export type CropRect = { x: number; y: number; width: number; height: number };
export type DrawingSettings = { tool: DrawingItem["type"] | "crop"; color: string; size: number; fontSize: number; text: string };
export const initialDrawingSettings: DrawingSettings = { tool: "brush", color: "#e5484d", size: 4, fontSize: 24, text: "" };
export const cropBetween = (a: DrawingPoint, b: DrawingPoint): CropRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
export function arrowLines(mark: Extract<DrawingItem, { type: "arrow" }>) {
    const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x), length = Math.max(mark.size * 4, 10);
    const head = (offset: number) => ({ x: mark.to.x - length * Math.cos(angle + offset), y: mark.to.y - length * Math.sin(angle + offset) });
    return [[mark.from, mark.to], [head(Math.PI / 6), mark.to, head(-Math.PI / 6)]];
}
export const textLines = (mark: Extract<DrawingItem, { type: "text" }>) => mark.text.split("\n").map((text, index) => ({ text, x: mark.position.x, y: mark.position.y + mark.size + index * mark.size * 1.25 }));

export async function renderEditedImage(image: HTMLImageElement, drawing: DrawingItem[], crop: CropRect | null) {
    const rect = crop || { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width)); canvas.height = Math.max(1, Math.round(rect.height));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法生成编辑图片");
    context.translate(-rect.x, -rect.y); context.drawImage(image, 0, 0);
    for (const mark of drawing) {
        context.strokeStyle = mark.color; context.fillStyle = mark.color; context.lineWidth = mark.size; context.lineCap = "round"; context.lineJoin = "round";
        if (mark.type === "text") {
            context.font = `${mark.size}px sans-serif`; context.textBaseline = "alphabetic";
            for (const line of textLines(mark)) context.fillText(line.text, line.x, line.y);
        } else if (mark.type === "brush" && mark.points.length === 1) {
            context.beginPath(); context.arc(mark.points[0].x, mark.points[0].y, mark.size / 2, 0, Math.PI * 2); context.fill();
        } else for (const points of mark.type === "brush" ? [mark.points] : arrowLines(mark)) {
            context.beginPath(); points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke();
        }
    }
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片生成失败，请调整编辑区域后重试")), "image/png"));
}
