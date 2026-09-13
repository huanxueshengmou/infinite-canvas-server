import { useState } from "react";
import { Button, Input } from "antd";
import { Code2, Eye } from "lucide-react";
import { Streamdown, defaultRehypePlugins, type Components, type UrlTransform } from "streamdown";
import type { NodeFields, SharedNode } from "@/services/api/collaboration";

// Parse Markdown with the installed library, without raw HTML or automatic remote loads.
const markdownPlugins = [defaultRehypePlugins.sanitize];
const safeUrl: UrlTransform = (value, key) => {
    if (key !== "href") return "";
    try {
        const url = new URL(value, window.location.origin);
        return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
};
const components: Components = {
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="opacity-60">[图片：{alt || "外部图片"}]</span>,
    pre: ({ children }) => <pre className="overflow-auto rounded border border-current/15 p-2 text-xs">{children}</pre>,
};

export function MarkdownContent({ content }: { content: string }) {
    return <Streamdown mode="static" controls={false} skipHtml rehypePlugins={markdownPlugins} urlTransform={safeUrl} components={components} className="space-y-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_table]:w-full [&_td]:border [&_td]:border-current/15 [&_td]:p-1 [&_th]:border [&_th]:border-current/15 [&_th]:p-1">{content}</Streamdown>;
}

export function MarkdownNode({ node, editable, onEdit, onBegin, onEnd }: {
    node: SharedNode; editable: boolean; onEdit: (fields: NodeFields) => void; onBegin: () => void; onEnd: () => void;
}) {
    const [editing, setEditing] = useState(!node.content);
    const showEditor = editing && editable;
    return <div data-canvas-no-zoom className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        <div className="flex items-center gap-2">
            <Input aria-label="Markdown 标题" variant="borderless" value={node.title} readOnly={!editable} onFocus={onBegin} onBlur={onEnd} onChange={(event) => onEdit({ title: event.target.value })} />
            <Button type="text" size="small" aria-label={showEditor ? "预览 Markdown" : "编辑 Markdown"} disabled={!editable} icon={showEditor ? <Eye className="size-4" /> : <Code2 className="size-4" />} onClick={() => { onEnd(); setEditing(!editing); }}>{showEditor ? "预览" : "编辑"}</Button>
        </div>
        {showEditor ? <Input.TextArea aria-label="Markdown 内容" variant="borderless" className="!min-h-0 !flex-1 !resize-none !font-mono !text-sm" value={node.content} placeholder={"# 标题\n\n输入 Markdown 内容…"} onFocus={onBegin} onBlur={onEnd} onChange={(event) => onEdit({ content: event.target.value })} /> : <div aria-label="Markdown 预览" className="min-h-0 flex-1 select-text overflow-auto break-words text-sm leading-relaxed">
            {node.content ? <MarkdownContent content={node.content} /> : <span className="opacity-50">暂无 Markdown 内容</span>}
        </div>}
    </div>;
}
