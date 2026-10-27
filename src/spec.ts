import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Kind = "read" | "write";

export interface AllowEntry {
  tool: string;
  kind: Kind;
  description: string;
  destructive?: boolean;
}
export type Allowlist = Record<string, AllowEntry>;

export interface ToolDef {
  name: string;
  operationId: string;
  kind: Kind;
  method: string;
  path: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pathParams: string[];
  queryParams: string[];
  /** Argument name of the Idempotency-Key header, when the operation takes one. */
  idempotency: "none" | "optional" | "required";
  hasBody: boolean;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const METHODS = ["get", "put", "post", "patch", "delete"] as const;
const DROP = new Set(["example", "examples", "discriminator", "xml", "externalDocs"]);

export function loadSpec(url: URL): Json {
  return parse(readFileSync(url, "utf8")) as Json;
}

export function loadAllowlist(url: URL): Allowlist {
  return JSON.parse(readFileSync(url, "utf8")) as Allowlist;
}

/** Inlines every $ref. A reference that points back into itself becomes an unconstrained schema. */
function deref(node: unknown, root: Json, stack: string[] = []): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, root, stack));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const ref: string = obj.$ref;
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
    if (stack.includes(ref)) return {};
    let target: any = root;
    for (const part of ref.slice(2).split("/")) target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (target === undefined) throw new Error(`unresolved $ref ${ref}`);
    return deref(target, root, [...stack, ref]);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DROP.has(k) || k.startsWith("x-")) continue;
    out[k] = deref(v, root, stack);
  }
  return out;
}

const snake = (s: string) => /^[a-z][a-z0-9_]{0,63}$/.test(s);

/**
 * One tool per allowlisted operationId. An operation that is not in the allowlist is never exposed, and an
 * allowlist entry without an operation, or with the wrong kind for its HTTP method, is a build error.
 */
export function buildTools(spec: Json, allow: Allowlist): ToolDef[] {
  const tools: ToolDef[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries<Json>(spec.paths)) {
    for (const method of METHODS) {
      const op: Json | undefined = item[method];
      const entry = op && allow[op.operationId];
      if (!op || !entry) continue;
      seen.add(op.operationId);
      if (!snake(entry.tool)) throw new Error(`${entry.tool}: tool names are snake_case`);
      if ((entry.kind === "read") !== (method === "get")) {
        throw new Error(`${op.operationId}: kind ${entry.kind} does not fit ${method.toUpperCase()}`);
      }
      if (entry.kind === "write" && !entry.description.startsWith("WRITE:")) {
        throw new Error(`${op.operationId}: a write tool description must start with "WRITE:"`);
      }

      const properties: Json = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      let idempotency: ToolDef["idempotency"] = "none";
      const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(p, spec));
      for (const p of params) {
        if (p.in === "path" || p.in === "query") {
          if (properties[p.name]) throw new Error(`${op.operationId}: duplicate parameter ${p.name}`);
          properties[p.name] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
          (p.in === "path" ? pathParams : queryParams).push(p.name);
          if (p.in === "path" || p.required) required.push(p.name);
        } else if (p.in === "header" && p.name.toLowerCase() === "idempotency-key") {
          idempotency = p.required ? "required" : "optional";
          properties.idempotency_key = {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description:
              "Unique value for this request. Repeating the call with the same value never repeats the action. If you omit it, a key derived from the arguments is used for 10 minutes.",
          };
          if (p.required) required.push("idempotency_key");
        }
      }
      const rb = op.requestBody && deref(op.requestBody, spec);
      const bodySchema = rb?.content?.["application/json"]?.schema;
      if (bodySchema) {
        if (properties.body) throw new Error(`${op.operationId}: a parameter is called body`);
        properties.body = bodySchema;
        if (rb.required) required.push("body");
      }
      if (entry.kind === "write") {
        properties.confirm = {
          const: true,
          description: "Must be true. Confirms that this call changes data or consumes quota.",
        };
        required.push("confirm");
      }

      tools.push({
        name: entry.tool,
        operationId: op.operationId,
        kind: entry.kind,
        method: method.toUpperCase(),
        path,
        description: entry.description,
        inputSchema: { type: "object", properties, required, additionalProperties: false },
        pathParams,
        queryParams,
        idempotency,
        hasBody: Boolean(bodySchema),
        annotations: {
          readOnlyHint: entry.kind === "read",
          destructiveHint: entry.destructive ?? false,
          idempotentHint: entry.kind === "read" || method !== "post" || idempotency !== "none",
          openWorldHint: op.operationId === "createWarmRun",
        },
      });
    }
  }
  for (const id of Object.keys(allow)) if (!seen.has(id)) throw new Error(`allowlist: no operation ${id} in the spec`);
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate tool names");
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
