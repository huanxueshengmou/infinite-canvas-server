import { resolve } from "node:path";
import { z } from "zod";

const positive = (fallback) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  DATA_DIR: z.string().default("./data"),
  FILES_DIR: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  STORAGE_SENTINEL: z.string().optional(),
  MASTER_KEY_FILE: z.string().optional(),
  MAX_ROOM_CONNECTIONS: positive(50),
  MAX_SYNC_BYTES: positive(1048576),
  MAX_FILE_BYTES: positive(524288000),
  MAX_API_RESPONSE_BYTES: positive(20971520),
  API_TIMEOUT_MS: positive(120000),
  SESSION_TTL_MS: positive(86400000),
  SHARE_TTL_MS: positive(604800000),
  SYNC_BATCH_MS: positive(150),
  AUTH_ATTEMPTS_PER_MINUTE: positive(10),
  WRITES_PER_MINUTE: positive(600),
  API_CONCURRENCY: positive(2),
  BACKUP_INTERVAL_MS: positive(60000),
  API_ALLOWED_HOSTS: z.string().default(""),
  STATIC_DIR: z.string().optional(),
});

export function getConfig(env = process.env) {
  const c = schema.parse(env);
  const origin = new URL(c.APP_ORIGIN);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("APP_ORIGIN must be a bare origin");
  if (c.NODE_ENV === "production" && origin.protocol !== "https:") throw new Error("Production requires an HTTPS APP_ORIGIN");
  const dataDir = resolve(c.DATA_DIR);
  return {
    ...c,
    APP_ORIGIN: origin.origin,
    DATA_DIR: dataDir,
    FILES_DIR: resolve(c.FILES_DIR || `${dataDir}/files`),
    BACKUP_DIR: c.BACKUP_DIR ? resolve(c.BACKUP_DIR) : undefined,
    MASTER_KEY_FILE: resolve(c.MASTER_KEY_FILE || `${dataDir}/master.key`),
    allowedHosts: c.API_ALLOWED_HOSTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    secureCookies: origin.protocol === "https:",
  };
}
