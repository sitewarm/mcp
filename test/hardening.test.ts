import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, Secret, callTool, configFromEnv, type Config } from "../src/call.js";
import { buildTools, loadAllowlist, loadSpec } from "../src/spec.js";

const tools = buildTools(
  loadSpec(new URL("../openapi/openapi.yaml", import.meta.url)),
  loadAllowlist(new URL("../tools/allowlist.json", import.meta.url)),
);
const byName = (n: string) => tools.find((t) => t.name === n)!;
const KEY = "swk_secret";
const cfg: Config = { baseUrl: "https://api.example.test/v1", apiKey: KEY, writes: true, timeoutMs: 1000 };
const site = () => ({ [byName("get_site").pathParams[0]!]: "s1" });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("timeout", () => {
  it.each([0, -1, Number.NaN])("a timeout of %s keeps the default instead of aborting at once", async (timeoutMs) => {
    const f = vi.fn(async () => json(200, { id: "s1" }));
    const r = await callTool(byName("get_site"), site(), { ...cfg, timeoutMs }, f as any);
    expect(r.isError).toBe(false);
    const init = (f.mock.calls[0] as any)[1] as RequestInit;
    expect(init.signal!.aborted).toBe(false);
  });

  it("configFromEnv sets a positive timeout", () => {
    const c = configFromEnv({ SITEWARM_API_URL: "https://api.example.test", SITEWARM_API_KEY: "k" });
    expect(c.timeoutMs).toBeGreaterThan(0);
  });
});

describe("retries", () => {
  it("never retries on its own: one request per call, whatever the answer or failure", async () => {
    for (const make of [() => json(503, {}), () => json(429, {}), () => Promise.reject(new Error("reset"))]) {
      const f = vi.fn(async () => make());
      const r = await callTool(byName("get_site"), site(), cfg, f as any);
      expect(r.isError).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
});

describe("response body", () => {
  it("a body that breaks off is a clean error, not an exception", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"id"'));
      },
      pull() {
        throw new Error("connection reset");
      },
    });
    const f = vi.fn(async () => new Response(body, { status: 200 }));
    const r = await callTool(byName("get_site"), site(), cfg, f as any);
    expect(r).toEqual({ isError: true, text: "The response body could not be read." });
  });

  it("a body over 32 MiB is cancelled and reported, a body of exactly 32 MiB is read", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1 << 20);
    let sent = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 40) c.enqueue(chunk);
        else c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await callTool(byName("get_site"), site(), cfg, (async () => new Response(big, { status: 200 })) as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/larger than 32 MiB/);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(40);

    const exact = new Uint8Array(MAX_BODY_BYTES).fill(0x20);
    const ok = await callTool(byName("get_site"), site(), cfg, (async () => new Response(exact, { status: 200 })) as any);
    expect(ok.isError).toBe(false);
  });
});

describe("list limit", () => {
  const list = byName("list_sites");
  const call = (limit: unknown) => {
    const f = vi.fn(async () => json(200, { data: [] }));
    return callTool(list, limit === "omit" ? {} : { limit }, cfg, f as any).then((r) => ({ r, f }));
  };

  it.each([-1, 101, 1.5, "5", "x", true, {}])("rejects limit %j before any request", async (limit) => {
    const { r, f } = await call(limit);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/limit must be an integer between 1 and 100/);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([[1, "1"], [100, "100"], [0, null], [null, null], ["omit", null]])("limit %j is sent as %j", async (limit, sent) => {
    const { r, f } = await call(limit);
    expect(r.isError).toBe(false);
    const url = (f.mock.calls[0] as any)[0] as URL;
    expect(url.searchParams.get("limit")).toBe(sent);
  });
});

describe("pagination", () => {
  it("is driven by the caller: a tool call returns one page and follows no cursor itself", async () => {
    const f = vi.fn(async () => json(200, { data: [], page: { has_more: true, next_cursor: "c1" } }));
    await callTool(byName("list_sites"), {}, cfg, f as any);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("the API key", () => {
  it("is in no default dump of the config", () => {
    const c = configFromEnv({ SITEWARM_API_URL: "https://api.example.test/v1", SITEWARM_API_KEY: "swk_real_key" });
    const dumps = [
      JSON.stringify(c),
      inspect(c, { depth: 5, showHidden: true }),
      `${c.apiKey}`,
      String(c.apiKey),
      JSON.stringify({ ...c }),
      inspect(c.apiKey),
      JSON.stringify(Object.getOwnPropertyNames(c.apiKey)),
    ];
    for (const d of dumps) expect(d).not.toContain("swk_real_key");
    expect((c.apiKey as Secret).reveal()).toBe("swk_real_key");
  });

  it("still authenticates when held in a Secret", async () => {
    const f = vi.fn(async () => json(200, {}));
    await callTool(byName("get_site"), site(), { ...cfg, apiKey: new Secret(KEY) }, f as any);
    expect(((f.mock.calls[0] as any)[1].headers as any).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("never reaches tool output, even if the API echoes it", async () => {
    const echo = vi.fn(async () => json(401, { title: "Unauthorized", detail: `bad key ${KEY}`, errors: [{ got: `Bearer ${KEY}` }] }));
    const bad = await callTool(byName("get_site"), site(), cfg, echo as any);
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain(KEY);

    const ok = await callTool(byName("get_site"), site(), cfg, (async () => json(200, { note: KEY })) as any);
    expect(ok.text).not.toContain(KEY);
  });

  it("an unexpected exception gives a generic message without the key", async () => {
    const t = { ...byName("get_site"), pathParams: ["siteId", "siteId"] };
    const r = await callTool(t, { siteId: "a" }, { ...cfg, baseUrl: "not a url" }, vi.fn() as any);
    expect(r).toEqual({ isError: true, text: "The request failed." });
  });
});

describe("redirects", () => {
  it("asks fetch not to follow them", async () => {
    const f = vi.fn(async () => json(200, {}));
    await callTool(byName("get_site"), site(), cfg, f as any);
    expect(((f.mock.calls[0] as any)[1] as RequestInit).redirect).toBe("error");
  });

  it("refuses an answer from a supplied fetch that followed one anyway", async () => {
    const followed = async () => {
      const res = json(200, { secret: "from another origin" });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    };
    const r = await callTool(byName("get_site"), site(), cfg, followed as any);
    expect(r).toEqual({ isError: true, text: "The API answered with a redirect. Redirects are not followed." });

    const moved = async () => {
      const res = json(200, {});
      Object.defineProperty(res, "url", { value: "https://other.example.test/x" });
      return res;
    };
    expect((await callTool(byName("get_site"), site(), cfg, moved as any)).isError).toBe(true);

    const r302 = await callTool(byName("get_site"), site(), cfg, (async () => new Response(null, { status: 302 })) as any);
    expect(r302.text).toMatch(/redirect/);
  });
});
