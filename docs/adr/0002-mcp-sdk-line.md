# ADR 0002: Official MCP TypeScript SDK Line

- Status: Accepted for M0
- Date: 2026-07-28
- Gate: G0

## Decision

Pin the stable v2 server line:

```text
@modelcontextprotocol/server 2.0.0
```

The first runtime is a local stdio server. M1 will use the stable v2 exports:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
```

M0 contains only a compile/runtime compatibility assertion for these exports;
it does not register product tools or open a transport.

## Context

The planning artifact originally required choosing a stable official line and
rejecting alpha or `main`-only APIs. At implementation time, the v2 split
packages were published as stable. The former monolithic
`@modelcontextprotocol/sdk` remains the v1 maintenance line and is not the
right default for a new server.

## Consequences

- MCP schemas owned by this repository remain independent from SDK-internal
  wire schemas.
- M1 must exercise the explicit Codex loop against the actual host; successful
  SDK imports do not prove host integration.
- stdio is the only accepted initial transport. HTTP adapters are not installed.
- Any SDK major/minor change requires the MCP contract and Codex integration
  suites to rerun on the same lockfile.

## Sources

- [MCP TypeScript SDK v2 package](https://www.npmjs.com/package/@modelcontextprotocol/server)
- [MCP TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases)
- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
