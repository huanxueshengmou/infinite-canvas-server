import { z } from "zod";

export const idSchema = z.string().uuid();
export const credentialsSchema = z.object({
  username: z.string().trim().min(1).regex(/^[\p{L}\p{N}_.@-]+$/u),
  password: z.string().min(12),
}).strict();
export const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const cursorSchema = z.object({ type: z.literal("cursor"), position: positionSchema.nullable() }).strict();

// Public records use an allowlist: no arbitrary plugin metadata, keys, prompts, URLs, or chat history.
export const nodeFieldsSchema = z.object({
  position: positionSchema.optional(),
  width: z.number().positive().finite().optional(),
  height: z.number().positive().finite().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  fileId: idSchema.nullable().optional(),
  outputType: z.enum(["text", "json"]).optional(),
}).strict();
export const privateSchema = z.object({
  title: z.string(),
  note: z.string(),
  category: z.enum(["request", "image", "video", "llm"]).default("request"),
  fields: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    label: z.string(),
    type: z.enum(["text", "number", "boolean"]),
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  }).strict()).default([]).refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length),
  request: z.object({
    url: z.string(),
    method: z.enum(["GET", "POST"]),
    apiKey: z.string(),
    header: z.enum(["Authorization", "x-api-key"]),
    body: z.string(),
  }).strict(),
  poll: z.object({ url: z.string(), taskIdPath: z.string() }).strict().optional(),
}).strict();

export const createNodeSchema = z.object({
  id: idSchema,
  kind: z.enum(["text", "image", "video", "file", "custom", "private"]),
  position: positionSchema,
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
  title: z.string().default(""),
  content: z.string().default(""),
  fileId: idSchema.nullable().default(null),
  outputType: z.enum(["text", "json"]).optional(),
  privateData: privateSchema.optional(),
}).strict();

export const edgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  sourcePort: z.literal("output"),
  target: idSchema,
  targetPort: z.enum(["input", "image", "audio"]),
}).strict();

export const templateSchema = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(["custom", "private"]),
  content: z.string().default(""),
  outputType: z.enum(["text", "json"]).default("text"),
  privateData: privateSchema.optional(),
}).strict().refine((value) => (value.kind === "private") === Boolean(value.privateData));

export const mutationSchema = z.object({
  operationId: idSchema,
  operations: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), node: createNodeSchema }).strict(),
    z.object({ type: z.literal("update"), id: idSchema, version: z.number().int().positive(), fields: nodeFieldsSchema }).strict(),
    z.object({ type: z.literal("delete"), id: idSchema, version: z.number().int().positive() }).strict(),
    z.object({ type: z.literal("connect"), edge: edgeSchema, version: z.number().int().positive().optional() }).strict(),
    z.object({ type: z.literal("disconnect"), id: idSchema, version: z.number().int().positive() }).strict(),
  ])).min(1),
}).strict();

export function publicNode(row) {
  const value = JSON.parse(row.public_json);
  if (row.visibility === "private") {
    return { id: row.id, kind: "private", position: value.position, width: value.width, height: value.height, title: "隐私节点", content: "", fileId: null, version: row.version };
  }
  return { id: row.id, kind: value.kind, position: value.position, width: value.width, height: value.height, title: value.title, content: value.content, fileId: value.fileId, version: row.version,
    ...(value.kind === "custom" ? { outputType: value.outputType || "text" } : {}) };
}

export const publicEdge = (row) => ({ id: row.id, source: row.source, sourcePort: row.source_port, target: row.target, targetPort: row.target_port, version: row.version });
