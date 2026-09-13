import { renderToStaticMarkup } from "react-dom/server";
import { canvasThemes, type CanvasColorTheme } from "@/lib/canvas-theme";
import { collaborationFileBlob, type SharedEdge, type SharedNode } from "@/services/api/collaboration";
import { ARCHIVE_ELEMENT_ID, ARCHIVE_FILE_PREFIX, archiveEdges, archiveNodes, safeArchiveName, sha256, validateArchive, type ArchiveAsset, type ArchiveProgress, type BoardArchive } from "./board-archive";
import { layoutNodes } from "./board-layout";
import { Marks } from "./drawing-surface";
import { MarkdownContent } from "./markdown-node";
import viewerScript from "./offline-viewer.js?raw";
import viewerStyles from "./offline-viewer.css?raw";

function OfflineCanvas({ archive }: { archive: BoardArchive }) {
    const nodes = layoutNodes(archive.nodes.map((node) => ({ ...node, version: 1 }))), byId = new Map(nodes.map((node) => [node.id, node]));
    return <>
        <header className="toolbar"><div className="heading"><h1>{archive.title}</h1><span>离线画布 · {nodes.length} 个节点 · {archive.assets.length} 个附件</span></div><nav aria-label="画布操作"><button id="zoom-out" aria-label="缩小">−</button><output id="zoom-level">100%</output><button id="zoom-in" aria-label="放大">＋</button><button id="fit">适应画布</button><button id="theme-toggle">切换主题</button></nav></header>
        <main id="offline-viewport" tabIndex={0} aria-label="离线画布">
            {!nodes.length && <p className="empty">这是一张空画布</p>}
            <div id="offline-world">
                <svg className="connections" width="1" height="1" aria-label="节点连线">{archive.edges.map((edge) => {
                    const source = byId.get(edge.source)!, target = byId.get(edge.target)!;
                    const x1 = source.position.x + source.width, y1 = source.position.y + source.height / 2, x2 = target.position.x, y2 = target.position.y + ({ input: 70, image: 112, audio: 154 }[edge.targetPort]);
                    const bend = Math.max(Math.abs(x2 - x1) / 2, 50);
                    return <path key={edge.id} data-edge-id={edge.id} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--muted)" strokeWidth="2" vectorEffect="non-scaling-stroke" />;
                })}</svg>
                {nodes.map((node) => <article key={node.id} data-node-id={node.id} data-node-kind={node.kind} className={`node ${node.kind === "group" ? "group" : ""}`} style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height }}>
                    <h2 title={node.title}>{node.title || "未命名节点"}</h2>
                    {node.kind === "whiteboard" ? <svg className="whiteboard" viewBox={`0 0 ${node.width} ${Math.max(1, node.height - 44)}`} preserveAspectRatio="none" aria-label="白板笔迹"><Marks drawing={node.drawing || []} /></svg>
                        : node.kind === "private" ? <p className="private-note">隐私 API 节点<br />私有配置与结果未导出<br />导入后可重新配置</p>
                        : node.kind === "markdown" ? <div className="scroll markdown"><MarkdownContent content={node.content} /></div>
                        : ["text", "custom"].includes(node.kind) ? <div className="scroll"><pre>{node.content}</pre></div>
                        : node.kind === "group" ? null : node.fileId ? <div className="file-content">
                            {node.kind === "image" && <img data-asset-id={node.fileId} alt={node.title} draggable={false} />}
                            {node.kind === "video" && <video data-asset-id={node.fileId} controls preload="metadata" playsInline />}
                            <p className="media-error" hidden={node.kind !== "file"}>{node.kind === "file" ? "此文件仅支持下载" : "此文件无法预览，可下载后打开"}</p>
                            <a data-download-id={node.fileId} href="#" download={safeArchiveName(node.title || "附件")}>下载 {node.title || "附件"}</a>
                        </div> : <p className="private-note">暂无内容</p>}
                </article>)}
            </div>
        </main>
        <footer>拖动空白处平移 · 滚轮或按钮缩放 · 双击图片查看大图 · 在协作空间选择「导入 HTML」可继续编辑</footer>
        <dialog id="image-preview"><button id="close-preview" aria-label="关闭图片预览">关闭</button><img alt="图片预览" /></dialog>
    </>;
}

function blobBase64(blob: Blob, signal: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
        signal.throwIfAborted();
        const reader = new FileReader(), abort = () => reader.abort();
        signal.addEventListener("abort", abort, { once: true });
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.onerror = () => reject(reader.error || new Error("附件读取失败"));
        reader.onabort = () => reject(new DOMException("导出已取消", "AbortError"));
        reader.onloadend = () => signal.removeEventListener("abort", abort);
        reader.readAsDataURL(blob);
    });
}

export async function exportBoardHtml(snapshot: { id: string; title: string; nodes: SharedNode[]; edges: SharedEdge[] }, theme: CanvasColorTheme, signal: AbortSignal, progress: ArchiveProgress) {
    const assets: ArchiveAsset[] = [], fileParts: BlobPart[] = [], nodes = archiveNodes(snapshot.nodes);
    const referenced = [...new Set(nodes.flatMap((node) => node.fileId ? [node.fileId] : []))];
    for (const [index, id] of referenced.entries()) {
        signal.throwIfAborted();
        const name = safeArchiveName(nodes.find((node) => node.fileId === id)?.title || id);
        progress(`正在打包附件 ${index + 1}/${referenced.length}：${name}`);
        const blob = await collaborationFileBlob(snapshot.id, id, signal);
        assets.push({ id, name, mime: blob.type as ArchiveAsset["mime"], size: blob.size, sha256: await sha256(blob) });
        fileParts.push(`<script id="${ARCHIVE_FILE_PREFIX}${id}" type="application/octet-stream">`, await blobBase64(blob, signal), "</script>\n");
    }
    signal.throwIfAborted(); progress("正在生成离线页面…");
    const archive = validateArchive({ app: "infinite-canvas-collaboration", version: 1, title: snapshot.title, exportedAt: new Date().toISOString(), nodes, edges: archiveEdges(snapshot.edges), assets });
    const styles = Object.entries(canvasThemes).map(([name, colors]) => `html[data-theme="${name}"]{--canvas:${colors.canvas.background};--dot:${colors.canvas.dot};--selection:${colors.canvas.selectionFill};--panel:${colors.node.panel};--text:${colors.node.text};--muted:${colors.node.muted};--stroke:${colors.node.stroke};--hover:${colors.toolbar.itemHover};color-scheme:${name}}`).join("\n");
    const scriptHash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(viewerScript)))));
    const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'`;
    // Escape '<' in JSON so node text can never close the inert data block and inject executable HTML.
    const json = JSON.stringify(archive).replace(/</g, "\\u003c");
    const blob = new Blob([
        `<!doctype html>\n<html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
        renderToStaticMarkup(<title>{archive.title} · 离线画布</title>), `<style>${styles}\n${viewerStyles}</style></head><body>`,
        renderToStaticMarkup(<OfflineCanvas archive={archive} />), `<script id="${ARCHIVE_ELEMENT_ID}" type="application/json">${json}</script>\n`,
        ...fileParts, `<script>${viewerScript}</script></body></html>`,
    ], { type: "text/html;charset=utf-8" });
    signal.throwIfAborted();
    return { blob, name: `${safeArchiveName(archive.title)}.html` };
}
