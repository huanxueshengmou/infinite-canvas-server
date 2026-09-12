import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertAllowedHost } from "./provider-policy.js";
import { outgoingHeaders } from "./request-config.js";

const policyFor = (config) => config.providerPolicy || { whitelistEnabled: true, whitelist: config.allowedHosts, blacklist: [] };

export function isPublicAddress(value) {
  try { return ipaddr.process(value).range() === "unicast"; } catch { return false; }
}

export async function resolveTarget(raw, policy, resolver = lookup) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("API 只允许不含账户信息的 HTTPS 443 地址");
  assertAllowedHost(url.hostname, policy);
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("禁止访问内网、回环、链路本地及云元数据地址");
  return { url, address: addresses[0] };
}

export async function executePrivateRequest(request, config, signal) {
  const { url, address } = await resolveTarget(request.url, policyFor(config));
  // Pin the verified DNS result to the actual TLS connection; never follow redirects.
  return new Promise((resolve, reject) => {
    const headers = outgoingHeaders(request);
    const req = https.request(url, {
      method: request.method,
      headers,
      agent: false,
      signal,
      family: address.family,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        reject(new Error("API 重定向已被拒绝"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > config.MAX_API_RESPONSE_BYTES) {
          response.destroy(new Error("API 响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        let text = Buffer.concat(chunks).toString("utf8");
        for (const secret of [request.apiKey, ...(request.headers || []).filter((header) => header.secret !== false).map((header) => header.value)]) if (secret) text = text.split(secret).join("[已隐藏密钥]");
        resolve({ status: response.statusCode, text });
      });
    });
    req.on("error", () => reject(new Error(signal.aborted ? "API 请求超时或已取消" : "API 请求失败，请检查域名及请求配置")));
    if (["GET", "HEAD"].includes(request.method) || typeof request.body === "string") req.end(["GET", "HEAD"].includes(request.method) ? undefined : request.body);
    else void pipeline(Readable.from(request.body), req, { signal }).catch(() => reject(new Error(signal.aborted ? "API 请求超时或已取消" : "API 附件读取或发送失败")));
  });
}

export const safeMediaTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/flac", "video/mp4", "video/webm"];

export async function openResultMedia(raw, config, signal) {
  const fail = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });
  if (raw.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(raw);
    if (!match || !safeMediaTypes.includes(match[1])) throw fail("结果媒体格式不受支持", 400);
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > config.MAX_FILE_BYTES) throw fail("结果媒体超过当前单文件上限", 413);
    signal.throwIfAborted();
    return { stream: Readable.from([bytes]), mime: match[1] };
  }
  let target;
  try { target = await resolveTarget(raw, policyFor(config)); }
  catch (error) { throw fail(error.message, 400); }
  const { url, address } = target;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", agent: false, signal, family: address.family,
      // Never forward an API key, application cookie or Authorization to a media host.
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, (response) => {
      const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (response.statusCode < 200 || response.statusCode >= 300 || !safeMediaTypes.includes(mime)) {
        response.destroy(); reject(fail("媒体请求失败、发生重定向或返回了不支持的格式")); return;
      }
      if (Number(response.headers["content-length"]) > config.MAX_FILE_BYTES) {
        response.destroy(); reject(fail("结果媒体超过当前单文件上限", 413)); return;
      }
      let size = 0;
      const limited = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > config.MAX_FILE_BYTES ? fail("结果媒体超过当前单文件上限", 413) : null, chunk);
      } });
      void pipeline(response, limited, { signal }).catch(() => {});
      resolve({ stream: limited, mime });
    });
    req.on("error", () => reject(fail(signal.aborted ? "媒体请求超时或已取消" : "媒体请求失败，请检查域名规则")));
    req.end();
  });
}
