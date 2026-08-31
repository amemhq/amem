# @amemhq/api

**The single-writer memory service for the [amem](../../) stack** — HTTP + MCP.

One process owns Qdrant, the embedding model, evolution and consolidation. Every consumer — the [`openclaw-amem`](../openclaw-amem) plugin in remote mode, a game brain — talks to it over HTTP or MCP. Consumers do not import [`amem-core`](../amem-core) or open their own Qdrant connection. That is what makes the single-writer guarantee **structural**, not a convention.

> ⚠️ **Not published, and not finished.** This package is `private` while its API settles.

## Status

| | |
| --- | --- |
| `GET /healthz` | ✅ readiness |
| memory routes (`/v1/memories`, …) | ✅ |
| MCP bridge (stdio) | ✅ |
| auth + non-localhost binding | ✅ |

## API

| | | |
| --- | --- | --- |
| `GET` | `/healthz` | `200` when Qdrant answers **and** the model is resident; `503` otherwise |
| `POST` | `/v1/memories` | full pipeline — LLM note construction, links, evolution → `201 {id}` |
| `POST` | `/v1/memories/episodic` | cheap append-only write, no LLM → `201 {id}` |
| `POST` | `/v1/memories/search` | hybrid BM25 + dense retrieval → `200 {results}` |
| `GET` | `/v1/memories/count` | `200 {count}` |
| `POST` | `/v1/maintenance/consolidate` | offline distillation → `200 {merged}` |
| `POST` | `/v1/maintenance/quality-scan` | `200 {items: [{noteId, reasons}]}` |

The service validates every write and search body against a schema. It refuses an undeclared field instead of dropping it silently. Failures answer with `{statusCode, error, detail?}` — `400` malformed request, `422` the quality gate refused the content, `503` Qdrant unreachable, `500` ours. `detail` is present only on `400` and `422`: a `5xx` message stays in the log.

Bodies take an optional `agentId` (default `main`). Writes take an optional `scope` of `private` (default) or `shared`.

## Run it

It needs Qdrant on `localhost:6333`. The service loads the embedding model before the port opens. The first request does not pay for the download. `/healthz` means something the moment it answers.

```bash
pnpm --filter @amemhq/api build
pnpm --filter @amemhq/api start
```

| env | default | what |
| --- | --- | --- |
| `AMEM_API_HOST` | `127.0.0.1` | bind address — loopback by default |
| `AMEM_API_PORT` | `7788` | port |
| `AMEM_API_TOKEN` | unset | when set, every request needs `Authorization: Bearer <token>` |
| `AMEM_API_LOG_LEVEL` | `info` | pino level |

## Auth

If you set `AMEM_API_TOKEN`, every request must carry `Authorization: Bearer <token>`. A missing or wrong token returns `401`. The comparison is constant-time. `/healthz` stays open — it is for probes and reveals only liveness, never memory content.

With no token, the service is open. This is safe **only** on loopback. As a result, the entrypoint enforces the pairing: **it refuses to bind a non-loopback host (`0.0.0.0`, a LAN address, …) unless `AMEM_API_TOKEN` is set**. It does not quietly expose an unauthenticated memory service to the network.

```bash
# open, loopback only — fine for a single local user
amem-api

# reachable from the network — a token is required, or it won't start
AMEM_API_HOST=0.0.0.0 AMEM_API_TOKEN=$(openssl rand -hex 32) amem-api
```

The MCP bridge keeps the mirror-image rule on the client side (loopback-only unless `AMEM_MCP_ALLOW_REMOTE=1`) — see below.

## MCP

`amem-mcp` speaks MCP over stdio. It exposes the same operations as five tools: **`memory_add`**, **`memory_add_episodic`**, **`memory_search`**, **`memory_consolidate`**, **`memory_quality_scan`**. Point any local MCP client at it:

```json
{
  "mcpServers": {
    "amem": { "command": "amem-mcp", "env": { "AMEM_API_URL": "http://127.0.0.1:7788" } }
  }
}
```

**It is a client of `amem-api`, not a second engine** — so `amem-api` must be running. That is deliberate. A stdio MCP server is spawned once *per client*. If this one owns the engine, every client that attaches will bring up its own Qdrant connection and its own embedding model. This is exactly the N-writers problem this service exists to prevent. As a thin client, it starts instantly with no model to load.

### Memories do not leave the machine by accident

Every tool call POSTs your memory content to `AMEM_API_URL`. A typo in a configuration file — or a configuration file someone else wrote — is otherwise enough to ship a lifetime of private notes to a host you never chose. As a result, **loopback is the only destination allowed by default**. Pointing the bridge off the machine must be a deliberate act:

```bash
AMEM_MCP_ALLOW_REMOTE=1 AMEM_API_URL=https://memory.internal:7788 amem-mcp
```

This mirrors the rule the server already keeps — `amem-api` binds `127.0.0.1` and demands a token before it will listen anywhere else. Memory must not leave the box quietly from either end. The service allows a plaintext remote (you can front it with your own TLS or a tunnel) but reports this on stderr.

| env | default | what |
| --- | --- | --- |
| `AMEM_API_URL` | `http://127.0.0.1:7788` | the `amem-api` to talk to; parsed, http(s) only, origin only |
| `AMEM_MCP_ALLOW_REMOTE` | unset | set to `1` to permit a non-loopback `AMEM_API_URL` |

## Single-writer rule

**Only one `amem-api` instance can write a given Qdrant collection.** This is deployment discipline, not something the code enforces. If two instances run against one collection, they will corrupt evolution and consolidation state. Any number of MCP clients can attach. They all go through the one service.

## License

MIT
