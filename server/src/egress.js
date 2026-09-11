import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export function isPublicAddress(value) {
  try { return ipaddr.process(value).range() === "unicast"; } catch { return false; }
}

export async function resolveTarget(raw, allowedHosts, resolver = lookup) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("API 只允许不含账户信息的 HTTPS 443 地址");
  if (!allowedHosts.includes(url.hostname.toLowerCase())) throw new Error("API 域名尚未加入管理员允许列表");
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("禁止访问内网、回环、链路本地及云元数据地址");
  return { url, address: addresses[0] };
}

export async function executePrivateRequest(request, config, signal) {
  const { url, address } = await resolveTarget(request.url, config.allowedHosts);
  // Pin the verified DNS result to the actual TLS connection; never follow redirects.
  return new Promise((resolve, reject) => {
    const headers = { "Accept": "application/json, text/plain", "Content-Type": "application/json" };
    if (request.apiKey) headers[request.header] = request.header === "Authorization" ? `Bearer ${request.apiKey}` : request.apiKey;
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
        if (size > config.MAX_FILE_BYTES) {
          response.destroy(new Error("API 响应超过单文件大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        let text = Buffer.concat(chunks).toString("utf8");
        if (request.apiKey) text = text.split(request.apiKey).join("[已隐藏密钥]");
        resolve({ status: response.statusCode, text });
      });
    });
    req.on("error", () => reject(new Error(signal.aborted ? "API 请求超时或已取消" : "API 请求失败，请检查域名及请求配置")));
    req.end(request.method === "POST" ? request.body : undefined);
  });
}
