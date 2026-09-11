import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [salt, expected] = encoded.split(":");
  const actual = await derive(password, salt, 64);
  const stored = Buffer.from(expected, "hex");
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

export async function loadMasterKey(path, allowCreate = true) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let key;
  try {
    key = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT" || !allowCreate) throw error;
    key = randomBytes(32);
    await writeFile(path, key, { flag: "wx", mode: 0o600 });
  }
  if (key.length !== 32) throw new Error("Invalid encryption key; refusing to replace it");
  await chmod(path, 0o600);
  return key;
}

// Each ciphertext is bound to its record and owner, so swapping database rows fails authentication.
export function encrypt(key, value, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(key, encoded, context) {
  const data = Buffer.from(encoded, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
