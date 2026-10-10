import { describe, expect, it } from '@gjsify/unit';

import {
  MessageReader,
  ProtocolError,
  encodeFailure,
  encodeNotification,
  encodeRequest,
  encodeSuccess,
  isNotification,
  isRequest,
  isResponse,
  parseLine,
  type JsonRpcMessage,
} from '@lotse/acp/jsonrpc';

export default async () => {
  await describe('MessageReader — chunk boundaries', async () => {
    await it('reassembles a message split across several push() calls', async () => {
      const reader = new MessageReader();
      const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
      const a = line.slice(0, 5);
      const b = line.slice(5, 12);
      const c = `${line.slice(12)}\n`;
      expect(reader.push(a)).toStrictEqual([]);
      expect(reader.push(b)).toStrictEqual([]);
      const messages = reader.push(c);
      expect(messages.length).toBe(1);
      expect((messages[0] as { method: string }).method).toBe('initialize');
    });

    await it('the buffer holds bytes mid-message and is empty once drained', async () => {
      const reader = new MessageReader();
      reader.push('{"jsonrpc":"2.0",');
      expect(reader.pending).not.toBe('');
      reader.push('"id":1,"method":"x"}\n');
      expect(reader.pending).toBe('');
    });
  });

  await describe('MessageReader — a } inside a string is not a message boundary', async () => {
    await it('survives a tool-call path, a diff and a model reply containing }', async () => {
      const reader = new MessageReader();
      const payload = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'here is a diff: function f() { return {a:1}; }' },
          },
        },
      };
      const messages = reader.push(`${JSON.stringify(payload)}\n`);
      expect(messages.length).toBe(1);
      const params = (messages[0] as { params: { update: { content: { text: string } } } }).params;
      expect(params.update.content.text).toContain('}');
    });
  });

  await describe('MessageReader — blank lines and framing edge cases', async () => {
    await it('skips blank lines between messages', async () => {
      const reader = new MessageReader();
      const one = encodeNotification('a', {});
      const two = encodeNotification('b', {});
      const messages = reader.push(`${one}\n\n\n${two}\n`);
      expect(messages.length).toBe(2);
    });

    await it('a non-JSON line throws ProtocolError', async () => {
      const reader = new MessageReader();
      expect(() => reader.push('not json at all\n')).toThrow(ProtocolError as unknown as typeof Error);
    });

    await it('rejects an array, a bare string, a number and null as not-a-message', async () => {
      expect(() => parseLine('[1,2,3]')).toThrow(ProtocolError as unknown as typeof Error);
      expect(() => parseLine('"just a string"')).toThrow(ProtocolError as unknown as typeof Error);
      expect(() => parseLine('42')).toThrow(ProtocolError as unknown as typeof Error);
      expect(() => parseLine('null')).toThrow(ProtocolError as unknown as typeof Error);
    });

    await it('rejects an id that is present but neither string, number nor null', async () => {
      expect(() => parseLine('{"jsonrpc":"2.0","id":true,"method":"x"}')).toThrow(
        ProtocolError as unknown as typeof Error,
      );
      expect(() => parseLine('{"jsonrpc":"2.0","id":{},"method":"x"}')).toThrow(
        ProtocolError as unknown as typeof Error,
      );
    });

    // Regression test — load-bearing. `opencode acp` sends `session/update` notifications
    // unprompted right after `session/new`, with no `id` at all. A parser that treated a
    // missing `id` as malformed dropped the connection on the very first real message a real
    // agent sends. Do not "fix" this to require an id.
    await it('a notification with NO id at all is valid', async () => {
      const message = parseLine('{"jsonrpc":"2.0","method":"session/update","params":{}}');
      expect(isNotification(message)).toBe(true);
    });

    await it('push over maxLineLength throws rather than growing without bound', async () => {
      const reader = new MessageReader(16);
      expect(() => reader.push('a'.repeat(17))).toThrow(ProtocolError as unknown as typeof Error);
    });
  });

  await describe('encode* — omit undefined params/result cleanly', async () => {
    await it('encodeRequest omits params when undefined', async () => {
      const line = encodeRequest(1, 'initialize');
      expect(JSON.parse(line)).toStrictEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    });

    await it('encodeRequest includes params when given', async () => {
      const line = encodeRequest(1, 'initialize', { a: 1 });
      expect(JSON.parse(line)).toStrictEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { a: 1 },
      });
    });

    await it('encodeNotification omits params when undefined', async () => {
      const line = encodeNotification('session/cancel');
      expect(JSON.parse(line)).toStrictEqual({ jsonrpc: '2.0', method: 'session/cancel' });
    });

    await it('encodeSuccess defaults result to {} but keeps a real result', async () => {
      expect(JSON.parse(encodeSuccess(1, undefined))).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
      expect(JSON.parse(encodeSuccess(1, { ok: true }))).toStrictEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
      });
    });

    await it('encodeFailure carries the error verbatim', async () => {
      const line = encodeFailure(1, { code: -32_601, message: 'method not found' });
      expect(JSON.parse(line)).toStrictEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32_601, message: 'method not found' },
      });
    });
  });

  await describe('isRequest / isNotification / isResponse — classification', async () => {
    await it('classifies a request', async () => {
      const message = { jsonrpc: '2.0', id: 1, method: 'initialize' } as JsonRpcMessage;
      expect(isRequest(message)).toBe(true);
      expect(isNotification(message)).toBe(false);
      expect(isResponse(message)).toBe(false);
    });

    await it('classifies a notification', async () => {
      const message = { jsonrpc: '2.0', method: 'session/update' } as JsonRpcMessage;
      expect(isRequest(message)).toBe(false);
      expect(isNotification(message)).toBe(true);
      expect(isResponse(message)).toBe(false);
    });

    await it('classifies a success and a failure response', async () => {
      const success = { jsonrpc: '2.0', id: 1, result: {} } as JsonRpcMessage;
      const failure = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } } as JsonRpcMessage;
      expect(isResponse(success)).toBe(true);
      expect(isResponse(failure)).toBe(true);
      expect(isRequest(success)).toBe(false);
      expect(isNotification(success)).toBe(false);
    });
  });
};
