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

## Why v1

`opencode acp` negotiates `protocolVersion: 1`. The upstream repository also carries
`schema/v2/schema.json`; v2 is a draft and is deliberately NOT vendored. When an agent answers
`initialize` with a `protocolVersion` kurier does not implement, `AcpClient.initialize` refuses
the connection rather than continuing on a guess.
