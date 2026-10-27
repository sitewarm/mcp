# @sitewarm/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server (stdio) for the sitewarm API. It lets an MCP client (an editor or an assistant) inspect sites, warm runs and cache reports, and, only when you turn it on, start and cancel warm runs and manage schedules. Node 20+.

**Status: pre-release (0.1.0, not published).** Skeleton and design. The tool set follows the OpenAPI spec in [`openapi/openapi.yaml`](openapi/openapi.yaml), which describes the planned API surface; the service may not offer every operation yet.

This package is the local launcher. It talks to the API over HTTPS with your API key and runs on your machine. It is not a hosted server.

## Run

```json
{
  "mcpServers": {
    "sitewarm": {
      "command": "npx",
      "args": ["-y", "@sitewarm/mcp"],
      "env": {
        "SITEWARM_API_URL": "https://<api host>/v1",
        "SITEWARM_API_KEY": "<key>"
      }
    }
  }
}
```

(`npx` works once a release is published; until then run `node dist/index.js` after `pnpm run build`.)

| Variable | Meaning |
| --- | --- |
| `SITEWARM_API_URL` | Required. The API base URL you were given. https only (http only for localhost). No default host. |
| `SITEWARM_API_KEY` | Required. Sent as `Authorization: Bearer`. Never logged, never in tool output or errors. |
| `SITEWARM_MCP_WRITE` | Set to `1` to list and allow write tools. Anything else, or unset: read tools only. |

Create a key with only the scopes you need. A read-only key plus no `SITEWARM_MCP_WRITE` is the safe default; the API enforces scopes whatever this server does.

## Tools

One tool per operation in [`tools/allowlist.json`](tools/allowlist.json), named after the operationId in snake_case. The allowlist is the only way a tool exists: new spec operations are not exposed until someone adds them, and a test checks the list against the spec.

**Read tools** (always listed): `list_sites`, `get_site`, `list_warm_runs`, `get_warm_run`, `list_warm_run_results`, `list_cache_status_reports`, `get_cache_status_report`, `list_schedules`, `get_schedule`. Lists return one page; pass `page.next_cursor` back as `cursor`. Start from `get_warm_run` (counts and verdict) and filter `list_warm_run_results` by state to keep answers small.

**Write tools** (listed only with `SITEWARM_MCP_WRITE=1`): `trigger_warm_run`, `cancel_warm_run`, `create_schedule`, `update_schedule`, `delete_schedule`. Their descriptions start with `WRITE:`.

### Cost and safety of write tools

- **They consume quota and send real traffic.** `trigger_warm_run` and every scheduled run request URLs on your site and its CDN and count against your plan's warm-request quota. Cancelling does not refund requests already sent.
- **Explicit confirmation.** Every write tool requires `confirm: true`. Without it the call is refused before any request is made, and the message tells the assistant to ask you first. Tool annotations mark them as not read-only (`delete_schedule` as destructive) so clients can prompt.
- **Idempotency.** `trigger_warm_run` takes an `idempotency_key`. If the assistant omits it, a key derived from the arguments is used for 10 minutes, so an accidental repeat does not start a second run.
- **No redirects, no passthrough.** The key goes only to `SITEWARM_API_URL`; redirects are refused. Error text comes from the API's RFC 9457 problem (`title`, `detail`, `code`, `action`, `Retry-After`), never from the request.

## Development

```
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build
```

To update the spec, replace `openapi/openapi.yaml`, then add or remove entries in `tools/allowlist.json`; tests fail if an entry has no operation or its kind does not match the HTTP method. `package.json` keeps `"private": true` until a release is decided.

## License

Apache-2.0, see [LICENSE](LICENSE).
