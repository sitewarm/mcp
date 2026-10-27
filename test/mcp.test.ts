import { describe, expect, it, vi } from "vitest";
import { callTool, configFromEnv, deriveIdempotencyKey, visibleTools, type Config } from "../src/call.js";
import { buildTools, loadAllowlist, loadSpec } from "../src/spec.js";

const spec = loadSpec(new URL("../openapi/openapi.yaml", import.meta.url));
const allow = loadAllowlist(new URL("../tools/allowlist.json", import.meta.url));
const tools = buildTools(spec, allow);
const byName = (n: string) => tools.find((t) => t.name === n)!;
const cfg: Config = { baseUrl: "https://api.example.test/v1", apiKey: "swk_secret", writes: true, timeoutMs: 1000 };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("tool registry", () => {
  it("maps the allowlist 1:1 to operationIds of the spec", () => {
    expect(tools.map((t) => t.operationId).sort()).toEqual(Object.keys(allow).sort());
  });

  it("reads are GET and writes are not", () => {
    for (const t of tools) expect(t.kind === "read").toBe(t.method === "GET");
  });

  it("exposes nothing outside the allowlist", () => {
    const all = Object.values<any>(spec.paths).flatMap((p) => ["get", "post", "put", "patch", "delete"].map((m) => p[m]?.operationId)).filter(Boolean);
    expect(tools.length).toBeLessThan(all.length);
    expect(tools.map((t) => t.operationId).every((id) => all.includes(id))).toBe(true);
  });

  it("requires confirm on every write tool and not on reads", () => {
    for (const t of tools) {
      const req = t.inputSchema.required as string[];
      expect(req.includes("confirm")).toBe(t.kind === "write");
      expect(t.description.startsWith("WRITE:")).toBe(t.kind === "write");
    }
  });

  it("requires the idempotency key where the spec does", () => {
    expect(byName("trigger_warm_run").idempotency).toBe("required");
    expect(byName("trigger_warm_run").inputSchema.properties).toHaveProperty("idempotency_key");
  });

  it("has no unresolved refs or extension keys in schemas", () => {
    const s = JSON.stringify(tools.map((t) => t.inputSchema));
    expect(s).not.toContain("$ref");
    expect(s).not.toContain("x-");
  });

  it("hides write tools unless writes are enabled", () => {
    expect(visibleTools(tools, { writes: false }).every((t) => t.kind === "read")).toBe(true);
    expect(visibleTools(tools, { writes: true }).length).toBe(tools.length);
  });

  it("rejects an allowlist entry whose kind does not fit the method", () => {
    expect(() => buildTools(spec, { listSites: { ...allow.listSites, kind: "write", description: "WRITE: x" } })).toThrow(/does not fit/);
  });

  it("rejects an allowlist entry without an operation", () => {
    expect(() => buildTools(spec, { nope: { tool: "nope", kind: "read", description: "x" } })).toThrow(/no operation/);
  });
});

describe("config", () => {
  const ok = { SITEWARM_API_URL: "https://api.example.test/v1/", SITEWARM_API_KEY: "swk_x" };
  it("has no default host and needs a key", () => {
    expect(() => configFromEnv({ SITEWARM_API_KEY: "k" })).toThrow(/SITEWARM_API_URL/);
    expect(() => configFromEnv({ SITEWARM_API_URL: ok.SITEWARM_API_URL })).toThrow(/SITEWARM_API_KEY/);
  });
  it("requires https except localhost and rejects credentials", () => {
    expect(() => configFromEnv({ ...ok, SITEWARM_API_URL: "http://api.example.test" })).toThrow(/https/);
    expect(() => configFromEnv({ ...ok, SITEWARM_API_URL: "http://localhost:8080/v1" })).not.toThrow();
    expect(() => configFromEnv({ ...ok, SITEWARM_API_URL: "https://u:p@api.example.test" })).toThrow(/credentials/);
  });
  it("writes are off unless SITEWARM_MCP_WRITE=1", () => {
    expect(configFromEnv(ok).writes).toBe(false);
    expect(configFromEnv({ ...ok, SITEWARM_MCP_WRITE: "true" }).writes).toBe(false);
    expect(configFromEnv({ ...ok, SITEWARM_MCP_WRITE: "1" }).writes).toBe(true);
    expect(configFromEnv(ok).baseUrl).toBe("https://api.example.test/v1");
  });
});

describe("callTool", () => {
  const site = (id: string) => tools.find((t) => t.operationId === "getSite" && id)!;

  it("builds the request for a read and sends the bearer key", async () => {
    const f = vi.fn(async () => json(200, { id: "s1" }));
    const t = byName("get_site");
    const pathParam = t.pathParams[0]!;
    const r = await callTool(t, { [pathParam]: "a/b" }, cfg, f as any);
    expect(r.isError).toBe(false);
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toContain("a%2Fb");
    expect((init.headers as any).Authorization).toBe("Bearer swk_secret");
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("GET");
    expect(site("x")).toBeTruthy();
  });

  it("refuses a write without confirm and never calls the API", async () => {
    const f = vi.fn();
    const r = await callTool(byName("cancel_warm_run"), { runId: "r1" }, cfg, f as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/confirm: true/);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a write when writes are disabled, even with confirm", async () => {
    const f = vi.fn();
    const r = await callTool(byName("cancel_warm_run"), { runId: "r1", confirm: true }, { ...cfg, writes: false }, f as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/SITEWARM_MCP_WRITE=1/);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects unknown and missing arguments", async () => {
    const f = vi.fn();
    expect((await callTool(byName("get_site"), { bogus: 1 }, cfg, f as any)).text).toMatch(/Unknown argument/);
    expect((await callTool(byName("get_site"), {}, cfg, f as any)).text).toMatch(/Missing required/);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends an Idempotency-Key, given or derived, and the derived one is stable", async () => {
    const t = byName("trigger_warm_run");
    const f = vi.fn(async () => json(202, { id: "run1" }));
    const args: Record<string, unknown> = { confirm: true, body: { source: { type: "sitemap" } } };
    for (const p of t.pathParams) args[p] = "s1";
    await callTool(t, { ...args, idempotency_key: "mine" }, cfg, f as any);
    await callTool(t, args, cfg, f as any);
    await callTool(t, args, cfg, f as any);
    const keys = f.mock.calls.map((c) => ((c as any)[1].headers as any)["Idempotency-Key"]);
    expect(keys[0]).toBe("mine");
    expect(keys[1]).toMatch(/^mcp-[0-9a-f]{32}$/);
    expect(keys[1]).toBe(keys[2]);
    expect(deriveIdempotencyKey("a", { x: 1, y: 2 }, 0)).toBe(deriveIdempotencyKey("a", { y: 2, x: 1 }, 0));
    expect(deriveIdempotencyKey("a", { x: 1 }, 0)).not.toBe(deriveIdempotencyKey("a", { x: 1 }, 11 * 60 * 1000));
  });

  it("maps a problem response to an error without leaking the key", async () => {
    const f = vi.fn(async () =>
      json(429, { title: "Too Many Requests", detail: "Quota used up", code: "quota-exceeded", action: "Wait or upgrade" }, { "Retry-After": "30" }),
    );
    const t = byName("get_site");
    const r = await callTool(t, { [t.pathParams[0]!]: "s1" }, cfg, f as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 429");
    expect(r.text).toContain("quota-exceeded");
    expect(r.text).toContain("next step: Wait or upgrade");
    expect(r.text).toContain("retry after: 30");
    expect(r.text).not.toContain("swk_secret");
  });

  it("reports transport failures without details that could leak", async () => {
    const f = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED Bearer swk_secret");
    });
    const t = byName("get_site");
    const r = await callTool(t, { [t.pathParams[0]!]: "s1" }, cfg, f as any);
    expect(r).toEqual({ isError: true, text: "Could not reach the API." });
  });
});
