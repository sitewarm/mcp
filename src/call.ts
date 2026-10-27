import { createHash } from "node:crypto";
import { inspect } from "node:util";
import type { ToolDef } from "./spec.js";
import { VERSION } from "./version.js";

/** Holds the API key so that logging, JSON.stringify, string interpolation or util.inspect of a config never shows it. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [inspect.custom](): string {
    return "[redacted]";
  }
}

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
export const USER_AGENT = `sitewarm-mcp/${VERSION} (+https://github.com/sitewarm/mcp)`;

export interface Config {
  baseUrl: string;
  apiKey: string | Secret;
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
    apiKey: new Secret(apiKey),
    writes: env.SITEWARM_MCP_WRITE === "1",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** `limit` must be an integer in 1..100; undefined, null or 0 mean the server default and are not sent. */
function limitError(v: unknown): string | undefined {
  if (v === undefined || v === null || v === 0) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) return "Argument limit must be an integer between 1 and 100.";
  return undefined;
}

/** Reads at most MAX_BODY_BYTES; a larger body is cancelled and reported, never buffered whole. */
async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

class BodyTooLargeError extends Error {}

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

const keyOf = (cfg: Config): string => (typeof cfg.apiKey === "string" ? cfg.apiKey : cfg.apiKey.reveal());

/** Defense in depth: an API that echoes the credential back never gets it into tool output. */
function redact(r: ToolResult, key: string): ToolResult {
  return key && r.text.includes(key) ? { ...r, text: r.text.split(key).join("[redacted]") } : r;
}

export async function callTool(
  tool: ToolDef,
  rawArgs: unknown,
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  try {
    return redact(await run(tool, rawArgs, cfg, fetchImpl), keyOf(cfg));
  } catch {
    return fail("The request failed.");
  }
}

async function run(tool: ToolDef, rawArgs: unknown, cfg: Config, fetchImpl: typeof fetch): Promise<ToolResult> {
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

  if (tool.queryParams.includes("limit")) {
    const bad = limitError(args.limit);
    if (bad) return fail(bad);
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
    if (v === undefined || v === null || (q === "limit" && v === 0)) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(q, String(x));
    else url.searchParams.set(q, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${keyOf(cfg)}`,
    Accept: "application/json, application/problem+json",
    "User-Agent": USER_AGENT,
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
      signal: AbortSignal.timeout(Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error).name;
    return fail(name === "TimeoutError" ? "The request timed out." : "Could not reach the API.");
  }

  // redirect: "error" stops a real fetch. A caller-supplied fetch may have followed one anyway; never use that answer.
  if (res.redirected || (res.status >= 300 && res.status < 400) || (res.url && new URL(res.url).origin !== url.origin)) {
    return fail("The API answered with a redirect. Redirects are not followed.");
  }

  let text: string;
  try {
    text = await readBody(res);
  } catch (e) {
    return fail(
      e instanceof BodyTooLargeError
        ? "The response is larger than 32 MiB and was not read."
        : (e as Error).name === "TimeoutError"
          ? "The request timed out."
          : "The response body could not be read.",
    );
  }
  let json: unknown;
  let parsed = true;
  try {
    json = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
    parsed = false;
  }
  if (res.ok) {
    // A 2xx body that is not JSON (an HTML page from a proxy, say) is an error that names the status, never the body.
    if (!parsed && res.status !== 204) return fail(`The API answered HTTP ${res.status} with a body that is not valid JSON.`);
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
