import { useState } from "react";
import { Download } from "lucide-react";
import { collaborationDownloadUrl, collaborationFileUrl, type SharedNode } from "@/services/api/collaboration";

export function FileNode({ roomId, node }: { roomId: string; node: SharedNode }) {
    const [failed, setFailed] = useState(false);
    if (!node.fileId) return null;
    const url = collaborationFileUrl(roomId, node.fileId);
    if (!failed && node.kind === "image") return <img className="min-h-0 w-full flex-1 object-contain p-3" src={url} alt={node.title} draggable={false} onError={() => setFailed(true)} />;
    if (!failed && node.kind === "video") return <video data-canvas-no-zoom className="min-h-0 w-full flex-1 object-contain p-3" controls preload="metadata" src={url} onError={() => setFailed(true)} />;
    return <div data-canvas-no-zoom className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-sm">
        <span className="text-xs opacity-60">{failed ? "此文件无法预览，可下载后打开" : "此文件仅支持下载"}</span>
        <a className="inline-flex max-w-full items-center gap-2 underline" href={collaborationDownloadUrl(roomId, node.fileId, node.title)} download={node.title}><Download className="size-4 shrink-0" /><span className="truncate">{node.title || "下载附件"}</span></a>
    </div>;
}
