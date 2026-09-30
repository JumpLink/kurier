/**
 * `@kurier/acp` — Agent Client Protocol, layer 1.
 *
 * Everything the protocol needs and nothing about how it is carried: the types against
 * `refs/acp/schema.v1.json`, the JSON-RPC codec, the transport seam, the client session
 * lifecycle, and the gate that answers what an agent is allowed to ask of a client.
 *
 * No `spawn`, no `node:child_process`, no `gi://`, no dependencies. That is not asceticism — it
 * is what makes the same code the Node unit tests and the GJS integration test both run against.
 */

export * from './types.ts';
export * from './methods.ts';
export * from './narrow.ts';
export * from './jsonrpc.ts';
export * from './transport.ts';
export * from './gate.ts';
export * from './client.ts';
