/**
 * JSON-RPC 2.0 over a line transport, and nothing else.
 *
 * ACP's stdio transport is newline-delimited JSON: one JSON value per line, no framing header,
 * no Content-Length. That is small enough to be worth getting exactly right, and wrong in exactly
 * two ways that both show up only against a real agent: a message split across two reads, and a
 * `}` inside a string (a tool-call path, a diff, a model reply) turning a naive
 * `split('\n')`/`indexOf('}')` parser into garbage.
 *
 * So: the parser is fed whatever the transport delivers and keeps a buffer; it only ever consumes
 * a line that is complete, and it never looks inside a line. The fixture-agent test in
 * `app/tests/unit/acp/jsonrpc.test.ts` drives both cases.
 */

import type { RequestId, WireError } from './types.ts';

export const JSONRPC_VERSION = '2.0';

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  error: WireError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function encodeRequest(id: RequestId, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

export function encodeNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, ...(params === undefined ? {} : { params }) });
}

export function encodeSuccess(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result: result ?? {} });
}

export function encodeFailure(id: RequestId, error: WireError): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error });
}

/** True for a message that carries an `id` and therefore expects an answer. */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message && message.id !== undefined;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && 'id' in message;
}

/**
 * The error raised for a JSON-RPC failure response. It carries the wire `code` because the
 * caller branches on it: `-32_000` means "authenticate first", which is the difference between
 * `kurier auth` and a crash.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: WireError) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

/** The error raised for a line that is not a JSON-RPC message at all. */
export class ProtocolError extends Error {
  readonly line: string;

  constructor(message: string, line: string) {
    super(`${message}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
    this.name = 'ProtocolError';
    this.line = line;
  }
}

/**
 * A line-oriented JSON-RPC reader. Feed it whatever the transport delivers; it returns the
 * messages that are complete and keeps the rest for the next chunk.
 *
 * It is a pure function of its input plus a private buffer, so it holds no I/O state and a test
 * can drive it chunk by chunk.
 */
export class MessageReader {
  #buffer = '';
  #maxLineLength: number;

  /**
   * @param maxLineLength a guard against a peer that never sends a newline. ACP's largest real
   *   message is a `session/update` carrying a model reply or a diff — kilobytes, not megabytes —
   *   so a megabyte of unterminated input means the framing is broken, not that the agent has a
   *   very large thought.
   */
  constructor(maxLineLength = 4 * 1024 * 1024) {
    this.#maxLineLength = maxLineLength;
  }

  /** Consume a chunk and return every complete message in it. */
  push(chunk: string): JsonRpcMessage[] {
    this.#buffer += chunk;
    if (this.#buffer.length > this.#maxLineLength) {
      const overflow = this.#buffer.length;
      this.#buffer = '';
      throw new ProtocolError(`no line ending after ${overflow} bytes`, '');
    }
    const messages: JsonRpcMessage[] = [];
    let start = 0;
    let newline: number;
    while ((newline = this.#buffer.indexOf('\n', start)) >= 0) {
      const line = this.#buffer.slice(start, newline).trim();
      start = newline + 1;
      if (line === '') continue;
      messages.push(parseLine(line));
    }
    this.#buffer = start === 0 ? this.#buffer : this.#buffer.slice(start);
    return messages;
  }

  /** The bytes held back because no newline has arrived yet. Empty once fully drained. */
  get pending(): string {
    return this.#buffer;
  }
}

export function parseLine(line: string): JsonRpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new ProtocolError('not JSON', line);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('not a JSON-RPC object', line);
  }
  const message = value as Record<string, unknown>;
  const id = message['id'];
  // `id` may be a string, a number, `null` (JSON-RPC allows it) — or **absent**, which is what a
  // notification is. Treating `undefined` as a failure breaks every notification, and the first
  // thing a real agent sends after `session/new` is one: `opencode acp` announces its slash
  // commands unprompted. Only a *present, wrong-typed* id is malformed.
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    throw new ProtocolError('id is neither a string, a number nor null', line);
  }
  if (typeof message['method'] !== 'string' && !('result' in message) && !('error' in message)) {
    throw new ProtocolError('neither a method nor a result nor an error', line);
  }
  if (typeof message['method'] !== 'string' && (id === undefined || id === null)) {
    throw new ProtocolError('a response without an id cannot be correlated', line);
  }
  return message as unknown as JsonRpcMessage;
}
