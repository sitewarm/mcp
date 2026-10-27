import { createHash } from "node:crypto";
import type { ToolDef } from "./spec.js";

export interface Config {
  baseUrl: string;
  apiKey: string;
  writes: boolean;
  timeoutMs: number;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

const IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

export function configFromEnv(env: Record<string, string | undefined>): Config {
  const baseUrl = env.SITEWARM_API_URL?.trim();
  const apiKey = env.SITEWARM_API_KEY?.trim();
  if (!baseUrl) throw new Error("SITEWARM_API_URL is not set (the API base URL you were given, https).");
  if (!apiKey) throw new Error("SITEWARM_API_KEY is not set.");
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new Error("SITEWARM_API_KEY must be printable ASCII without whitespace.");
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error("SITEWARM_API_URL is not a valid URL.");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("SITEWARM_API_URL must be https.");
  if (u.username || u.password) throw new Error("SITEWARM_API_URL must not contain credentials.");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    writes: env.SITEWARM_MCP_WRITE === "1",
    timeoutMs: 30_000,
  };
}

/** Write tools are not even listed unless the operator turned them on. */
export function visibleTools(tools: ToolDef[], cfg: Pick<Config, "writes">): ToolDef[] {
  return cfg.writes ? tools : tools.filter((t) => t.kind === "read");
}

export function deriveIdempotencyKey(tool: string, args: Record<string, unknown>, now = Date.now()): string {
  const { idempotency_key: _k, confirm: _c, ...rest } = args;
  const h = createHash("sha256")
    .update(JSON.stringify([tool, sortKeys(rest), Math.floor(now / IDEMPOTENCY_BUCKET_MS)]))
    .digest("hex");
  return `mcp-${h.slice(0, 32)}`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

const fail = (text: string): ToolResult => ({ isError: true, text });

export async function callTool(
  tool: ToolDef,
  rawArgs: unknown,
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || Array.isArray(args)) return fail("Arguments must be an object.");
  if (tool.kind === "write") {
    if (!cfg.writes) return fail(`${tool.name} is disabled. The operator must start this server with SITEWARM_MCP_WRITE=1.`);
    if (args.confirm !== true) {
      return fail(`${tool.name} changes data or consumes quota. Ask the user, then call again with confirm: true.`);
    }
  }
  const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(args).filter((k) => !(k in props));
  if (unknown.length) return fail(`Unknown argument(s): ${unknown.join(", ")}.`);
  for (const r of (tool.inputSchema.required ?? []) as string[]) {
    if (args[r] === undefined && r !== "idempotency_key") return fail(`Missing required argument: ${r}.`);
  }

  let path = tool.path;
  for (const p of tool.pathParams) {
    const v = args[p];
    if (typeof v !== "string" && typeof v !== "number") return fail(`Argument ${p} must be a string.`);
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }
  const url = new URL(cfg.baseUrl + path);
  for (const q of tool.queryParams) {
    const v = args[q];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(q, String(x));
    else url.searchParams.set(q, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "application/json, application/problem+json",
    "User-Agent": "sitewarm-mcp",
  };
  let body: string | undefined;
  if (tool.hasBody && args.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(args.body);
  }
  if (tool.idempotency !== "none") {
    const given = args.idempotency_key;
    headers["Idempotency-Key"] = typeof given === "string" && given ? given : deriveIdempotencyKey(tool.name, args);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: tool.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    return fail(name === "TimeoutError" ? "The request timed out." : "Could not reach the API.");
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (res.ok) {
    const out = json === undefined ? (text || "OK") : JSON.stringify(json, null, 2);
    return { isError: false, text: out };
  }
  return fail(describeProblem(res, json));
}

/** RFC 9457 problem to a message the model can act on. The API key is never part of it. */
export function describeProblem(res: Response, json: unknown): string {
  const p = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const parts = [`HTTP ${res.status}${typeof p.title === "string" ? ` ${p.title}` : ""}`];
  if (typeof p.detail === "string") parts.push(p.detail);
  if (typeof p.code === "string") parts.push(`code: ${p.code}`);
  if (typeof p.action === "string") parts.push(`next step: ${p.action}`);
  const ra = res.headers.get("retry-after");
  if (ra) parts.push(`retry after: ${ra}`);
  if (Array.isArray(p.errors)) parts.push(`errors: ${JSON.stringify(p.errors).slice(0, 1000)}`);
  return parts.join("\n");
}
