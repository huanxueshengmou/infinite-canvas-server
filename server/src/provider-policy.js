import { domainToASCII } from "node:url";
import { z } from "zod";

export const normalizeHost = (host) => domainToASCII(host.trim().toLowerCase().replace(/\.$/, ""));
const host = z.string().transform(normalizeHost).pipe(z.hostname());
export const providerPolicySchema = z.object({
  whitelistEnabled: z.boolean(),
  whitelist: z.array(host).transform((hosts) => [...new Set(hosts)]),
  blacklist: z.array(host).transform((hosts) => [...new Set(hosts)]),
}).strict();

export async function providerPolicy(db, config) {
  const setting = await db.get("SELECT value FROM settings WHERE key='api_host_policy'");
  if (setting) return providerPolicySchema.parse(JSON.parse(setting.value));
  const previous = await db.get("SELECT value FROM settings WHERE key='api_hosts'");
  return providerPolicySchema.parse({ whitelistEnabled: true, whitelist: previous ? JSON.parse(previous.value) : config.allowedHosts, blacklist: [] });
}

export function assertAllowedHost(hostname, policy) {
  const name = normalizeHost(hostname);
  if (policy.whitelistEnabled) {
    if (!policy.whitelist.some((host) => normalizeHost(host) === name)) throw new Error("API 域名未列入当前白名单");
  } else if (policy.blacklist.some((host) => name === normalizeHost(host) || name.endsWith(`.${normalizeHost(host)}`))) throw new Error("API 域名被当前黑名单禁止");
}
