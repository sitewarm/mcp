import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { USER_AGENT, callTool, type Config } from "../src/call.js";
import { VERSION } from "../src/version.js";
import { buildTools, loadAllowlist, loadSpec } from "../src/spec.js";

const tools = buildTools(
  loadSpec(new URL("../openapi/openapi.yaml", import.meta.url)),
  loadAllowlist(new URL("../tools/allowlist.json", import.meta.url)),
);
const byName = (n: string) => tools.find((t) => t.name === n)!;
const cfg: Config = { baseUrl: "https://api.example.test/v1", apiKey: "swk_secret", writes: true, timeoutMs: 1000 };
const site = () => ({ [byName("get_site").pathParams[0]!]: "s1" });

describe("non-JSON success", () => {
  it("a 2xx body that is not JSON is an error with the status and without the body", async () => {
    const f = vi.fn(async () => new Response("<html>secret-proxy-page</html>", { status: 200 }));
    const r = await callTool(byName("get_site"), site(), cfg, f as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("200");
    expect(r.text).not.toContain("secret-proxy-page");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an empty 2xx body is still fine", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    const r = await callTool(byName("get_site"), site(), cfg, f as any);
    expect(r).toEqual({ isError: false, text: "OK" });
  });
});

describe("User-Agent and base path", () => {
  it("carries the version and URL", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await callTool(byName("get_site"), site(), cfg, f as any);
    const headers = (f.mock.calls[0] as any)[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`sitewarm-mcp/${VERSION} (+https://github.com/sitewarm/mcp)`);
    expect(USER_AGENT).toBe(headers["User-Agent"]);
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("keeps percent-encoding in the base path", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await callTool(byName("get_site"), site(), { ...cfg, baseUrl: "https://x.test/a%2Fb/v1" }, f as any);
    expect(String((f.mock.calls[0] as any)[0])).toBe("https://x.test/a%2Fb/v1/sites/s1");
  });
});
