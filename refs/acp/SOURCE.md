# refs/acp — the normative ACP artifacts

`schema.v1.json` is the **published JSON Schema of Agent Client Protocol v1**, copied verbatim
from the protocol's own repository and re-serialised with sorted keys only, so a refresh shows
a real diff and nothing else. It is the artifact `packages/acp`'s types are written against —
not against blog posts, not against one agent's output.

| | |
|---|---|
| Upstream | <https://github.com/agentclientprotocol/agent-client-protocol> |
| Path in upstream | `schema/v1/schema.json` |
| Pinned commit | `f05af18d9708f31c85fa62e172ac0968df042cf0` (2026-09-30) |
| Licence | Apache-2.0 (upstream), compatible with this repo's AGPL-3.0 |

## Refresh it

```bash
./scripts/update-acp-schema
```

The script writes the new schema, then runs `npm run check:schema` (see
`scripts/check-schema.mjs`). **Read the diff before committing it.** A schema change means the
types, the method table and the capability check in `packages/acp` may all need to move — a
refresh that only changes the JSON is a sign the schema was copied but not read.

## What one real agent answers

The schema says what is allowed. What `opencode acp` 2.0.19 actually sent back to `initialize`,
measured inside one GJS process with no Node anywhere in the chain, is the verbatim result block in
[README.md](../../README.md#why-acp-instead-of-one-sdk-per-agent) — kept there in one copy so a
re-measurement cannot update half of them.

Three things about it belong here, next to the schema:

- The `authMethods` entry carries a **`description` the schema does not define**, and no `type` tag.
  That is trap 1 in [AGENTS.md](../../AGENTS.md#the-two-traps): a real, interactive auth method the
  client has to arrange itself.
- `sessionCapabilities` carries a **`fork` marker v1 does not define**. Unknown capability keys and
  unknown `_meta` must never be an error (guardrail 4).
- `mcpCapabilities` is `{"http":true,"sse":false}`, which is why a host's own MCP server may be
  stdio or HTTP but not SSE.

## Why v1

`opencode acp` negotiates `protocolVersion: 1`. The upstream repository also carries
`schema/v2/schema.json`; v2 is a draft and is deliberately NOT vendored. When an agent answers
`initialize` with a `protocolVersion` lotse does not implement, `AcpClient.initialize` refuses
the connection rather than continuing on a guess.
