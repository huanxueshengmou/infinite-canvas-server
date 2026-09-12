import { FormData } from "formdata-node";
import { FormDataEncoder } from "form-data-encoder";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { MIMEType } from "node:util";
import { FileInput, renderJson, renderText, requestBody } from "./workflow.js";
import { readEncryptedFile } from "./storage.js";
import { HttpError } from "./rooms.js";

const scalar = (value) => typeof value === "string" ? value : JSON.stringify(value, (_key, item) => {
  if (item instanceof FileInput) throw new HttpError(400, "附件请作为 multipart 字段的完整占位符传入");
  return item;
});

export function prepareRequest(request, context, key, config, signal) {
  const outgoing = { ...request, url: renderText(request.url, context, true), body: "", contentType: undefined };
  if (["GET", "HEAD"].includes(request.method)) return { outgoing, cleanup: async () => {} };
  const format = request.bodyFormat || "json";
  if (format === "text") {
    outgoing.body = renderText(request.body, context);
    outgoing.contentType = new MIMEType(request.contentType || "text/plain; charset=utf-8").toString();
  } else if (request.body.trim()) {
    const value = renderJson(request.body, context);
    if (format === "json") {
      outgoing.body = requestBody(value, key, config, signal);
      outgoing.contentType = "application/json";
    } else {
      if (!value || Array.isArray(value) || typeof value !== "object") throw new HttpError(400, "表单模板需要是字段名与值组成的 JSON 对象");
      if (format === "urlencoded") {
        const form = new URLSearchParams();
        for (const [name, values] of Object.entries(value)) for (const item of Array.isArray(values) ? values : [values]) form.append(name, scalar(item));
        outgoing.body = form.toString();
        outgoing.contentType = "application/x-www-form-urlencoded";
      } else {
        const form = new FormData(), transfer = new AbortController();
        const bodySignal = AbortSignal.any([signal, transfer.signal]);
        for (const [name, values] of Object.entries(value)) for (const item of Array.isArray(values) ? values : [values]) {
          if (item instanceof FileInput) {
            // File-like adapter: the encoder reads authenticated bytes lazily without buffering the file.
            form.append(name, {
              name: item.file.id, type: item.file.mime, size: item.file.size, [Symbol.toStringTag]: "File",
              async *stream() {
                bodySignal.throwIfAborted();
                const data = await readEncryptedFile(item.file.id, key, config, item.file.size, bodySignal);
                try { for await (const chunk of data.stream) { bodySignal.throwIfAborted(); yield chunk; } }
                finally { await data.cleanup(); }
              },
            });
          } else form.append(name, scalar(item));
        }
        const encoder = new FormDataEncoder(form, `canvas-${randomUUID()}`);
        outgoing.contentType = encoder.contentType;
        outgoing.contentLength = encoder.contentLength === undefined ? undefined : Number(encoder.contentLength);
        outgoing.body = Readable.from(encoder, { objectMode: false, signal: bodySignal });
        const completion = finished(outgoing.body, { cleanup: true }).catch(() => {});
        return { outgoing, cleanup: async () => { transfer.abort(); outgoing.body.destroy(); await completion; } };
      }
    }
  }
  return { outgoing, cleanup: async () => { if (typeof outgoing.body !== "string") await outgoing.body.return?.(); } };
}
