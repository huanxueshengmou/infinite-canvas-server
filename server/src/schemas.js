import { z } from "zod";

export const idSchema = z.string().uuid();
export const credentialsSchema = z.object({
  username: z.string().trim().min(1).regex(/^[\p{L}\p{N}_.@-]+$/u),
  password: z.string().min(12),
}).strict();
export const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();

// Public records use an allowlist: no arbitrary plugin metadata, keys, prompts, URLs, or chat history.
export const nodeFieldsSchema = z.object({
  position: positionSchema.optional(),
  width: z.number().positive().finite().optional(),
  height: z.number().positive().finite().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  fileId: idSchema.nullable().optional(),
}).strict();
export const privateSchema = z.object({
  title: z.string(),
  note: z.string(),
  request: z.object({
    url: z.string(),
    method: z.enum(["GET", "POST"]),
    apiKey: z.string(),
    header: z.enum(["Authorization", "x-api-key"]),
    body: z.string(),
  }).strict(),
}).strict();

export const createNodeSchema = z.object({
  id: idSchema,
  kind: z.enum(["text", "image", "file", "private"]),
  position: positionSchema,
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  title: z.string().default(""),
  content: z.string().default(""),
  fileId: idSchema.nullable().default(null),
  privateData: privateSchema.optional(),
}).strict();

export const mutationSchema = z.object({
  operationId: idSchema,
  operations: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), node: createNodeSchema }).strict(),
    z.object({ type: z.literal("update"), id: idSchema, version: z.number().int().positive(), fields: nodeFieldsSchema }).strict(),
    z.object({ type: z.literal("delete"), id: idSchema, version: z.number().int().positive() }).strict(),
  ])).min(1),
}).strict();

export function publicNode(row) {
  const value = JSON.parse(row.public_json);
  if (row.visibility === "private") {
    return { id: row.id, kind: "private", position: value.position, width: value.width, height: value.height, title: "隐私节点", content: "", fileId: null, version: row.version };
  }
  return { id: row.id, kind: value.kind, position: value.position, width: value.width, height: value.height, title: value.title, content: value.content, fileId: value.fileId, version: row.version };
}
