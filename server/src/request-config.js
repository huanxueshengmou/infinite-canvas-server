import { validateHeaderName, validateHeaderValue } from "node:http";
import { MIMEType } from "node:util";
import { z } from "zod";

const forbidden = new Set(["host", "cookie", "set-cookie", "content-type", "content-length", "transfer-encoding", "connection", "upgrade", "expect", "te", "trailer", "forwarded", "x-real-ip", "accept-encoding"]);
const headerName = z.string().trim().min(1).refine((value) => {
  try { validateHeaderName(value); return !forbidden.has(value.toLowerCase()) && !/^(proxy-|x-forwarded-)/i.test(value); } catch { return false; }
}, "请求头名称无效，或属于连接、Cookie、代理等保留字段");
const headerValue = z.string().refine((value) => { try { validateHeaderValue("value", value); return true; } catch { return false; } }, "请求头不能包含换行或无效字符");
export const requestSchema = z.object({
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  apiKey: headerValue,
  header: headerName,
  authMode: z.enum(["auto", "raw", "none"]).default("auto"),
  body: z.string(),
  bodyFormat: z.enum(["json", "urlencoded", "multipart", "text"]).default("json"),
  contentType: z.string().refine((value) => { try { new MIMEType(value); validateHeaderValue("Content-Type", value); return true; } catch { return false; } }, "请输入有效的 MIME 类型").default("text/plain; charset=utf-8"),
  headers: z.array(z.object({ name: headerName, value: headerValue, secret: z.boolean().default(true) }).strict()).default([])
    .refine((headers) => new Set(headers.map((header) => header.name.toLowerCase())).size === headers.length, "请求头名称不能重复"),
}).strict();

export function withoutCredentials(data) {
  return { ...data, request: { ...data.request, apiKey: "", headers: (data.request.headers || []).map((header) => ({ ...header, value: header.secret !== false ? "" : header.value })) } };
}

export function outgoingHeaders(request) {
  const headers = { accept: "application/json, text/plain" };
  for (const header of request.headers || []) { headerName.parse(header.name); headerValue.parse(header.value); if (header.value) headers[header.name.toLowerCase()] = header.value; }
  if (request.contentType) headers["content-type"] = request.contentType;
  if (request.contentLength !== undefined) headers["content-length"] = request.contentLength;
  else if (request.body && typeof request.body !== "string" && !["GET", "HEAD"].includes(request.method)) headers["transfer-encoding"] = "chunked";
  if (request.apiKey && request.authMode !== "none") {
    const name = headerName.parse(request.header).toLowerCase();
    if (headers[name]) throw new Error("密钥请求头与自定义请求头重复，请只保留一处");
    headers[name] = name === "authorization" && request.authMode !== "raw" ? `Bearer ${request.apiKey}` : request.apiKey;
    validateHeaderValue(name, headers[name]);
  }
  return headers;
}
