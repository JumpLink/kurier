import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import {
  FileSystemRefusedError,
  KURIER_CLIENT_CAPABILITIES,
  KURIER_IMPLEMENTATION,
  assertScopeIsNotAuthority,
  classifyAuthMethods,
  denyAll,
  rejectOnce,
} from '@lotse/acp/gate';
import { UNSUPPORTED_AGENT_METHODS } from '@lotse/acp/methods';
import type { Transport } from '@lotse/acp/transport';
import {
  ERROR_CODES,
  type AuthMethodInfo,
  type PermissionOption,
  type RequestPermissionRequest,
} from '@lotse/acp/types';
import { newSession } from '@lotse/session';

import { FixtureAgent } from '../../support/fixture-agent.ts';

/** Passes writes through to `inner` while recording every raw line the client sends, so a test
 * can inspect the exact wire response — the fixture itself only tracks permission outcomes. */
function loggingTransport(inner: Transport): { transport: Transport; sentLines: string[] } {
  const sentLines: string[] = [];
  const transport: Transport = {
    get closed() {
      return inner.closed;
    },
    write: (data) => {
      sentLines.push(data);
      inner.write(data);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onClose: (listener) => inner.onClose(listener),
    close: () => inner.close(),
  };
  return { transport, sentLines };
}

/** Captures the listener AcpClient registers so a test can inject a message from "the peer"
 * that no FixtureAgent option produces — an unknown `sessionUpdate` kind. */
function injectableTransport(inner: Transport): { transport: Transport; inject: (data: string) => void } {
  let listener: ((data: string) => void) | undefined;
  const transport: Transport = {
    get closed() {
      return inner.closed;
    },
    write: (data) => inner.write(data),
    onMessage: (l) => {
      listener = l;
      inner.onMessage(l);
    },
    onClose: (l) => inner.onClose(l),
    close: () => inner.close(),
  };
  return { transport, inject: (data: string) => listener?.(data) };
}

function permissionRequest(options: PermissionOption[]): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', title: 'edit a file', status: 'pending' },
    options,
  };
}

export default async () => {
  await describe('Fail closed by default — guardrail 2', async () => {
    await it('session/request_permission against DENY_EVERYTHING is answered {outcome:{outcome:"cancelled"}} on the wire', async () => {
      const fixture = new FixtureAgent({
        permissionOptions: [
          { optionId: 'allow_1', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' },
        ],
      });
      // No gate passed — this is the default DENY_EVERYTHING, exercised as a real client would.
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(fixture.permissionOutcomes[0]).toStrictEqual({ outcome: { outcome: 'cancelled' } });
    });

    await it('denyAll always returns null', async () => {
      expect(denyAll(permissionRequest([{ optionId: 'a', name: 'Allow', kind: 'allow_once' }]))).toBe(null);
    });

    await it("rejectOnce picks the agent's reject_once; returns null when only allow_* was offered", async () => {
      const both = permissionRequest([
        { optionId: 'allow_1', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' },
      ]);
      expect(rejectOnce(both)).toBe('reject_1');

      // An agent offering only allow options must not get an allow out of a gate that declined.
      const onlyAllow = permissionRequest([{ optionId: 'allow_1', name: 'Allow', kind: 'allow_once' }]);
      expect(rejectOnce(onlyAllow)).toBe(null);
    });
  });

  await describe('A gate that throws is a gate that did not approve', async () => {
    await it('a throwing permission gate yields cancelled, never selected', async () => {
      const fixture = new FixtureAgent({
        permissionOptions: [{ optionId: 'allow_1', name: 'Allow', kind: 'allow_once' }],
      });
      const client = new AcpClient({
        transport: fixture.transport,
        gate: {
          permission: () => {
            throw new Error('the gate itself is broken');
          },
        },
      });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(fixture.permissionOutcomes[0]).toStrictEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  await describe('fs is refused, not ignored', async () => {
    await it('fs/read_text_file gets a method-not-found error and the turn continues; FileSystemRefusedError names the path', async () => {
      const fixture = new FixtureAgent({ requestFileSystem: 'read' });
      const { transport, sentLines } = loggingTransport(fixture.transport);
      const client = new AcpClient({ transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const response = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      const refusal = sentLines.map((line) => JSON.parse(line)).find((m) => 'error' in m) as
        | { error: { code: number; message: string } }
        | undefined;
      expect(refusal).toBeTruthy();
      expect(refusal?.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
      expect(refusal?.error.message).toContain('/etc/shadow');
      // The refusal does not end the turn — the agent is expected to carry on without the
      // capability, which the fixture models by finishing normally.
      expect(response.stopReason).toBe('end_turn');
    });

    await it('fs/write_text_file is refused the same way', async () => {
      const fixture = new FixtureAgent({ requestFileSystem: 'write' });
      const { transport, sentLines } = loggingTransport(fixture.transport);
      const client = new AcpClient({ transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      const refusal = sentLines.map((line) => JSON.parse(line)).find((m) => 'error' in m) as
        | { error: { code: number } }
        | undefined;
      expect(refusal?.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
    });

    await it('FileSystemRefusedError names the path in its message', async () => {
      const error = new FileSystemRefusedError('/etc/shadow');
      expect(error.name).toBe('FileSystemRefusedError');
      expect(error.path).toBe('/etc/shadow');
      expect(error.message).toContain('/etc/shadow');
    });
  });

  await describe('An unknown agent method is answered, not fatal', async () => {
    await it('sendUnknownMethod gets a JSON-RPC error response and the connection stays open', async () => {
      const fixture = new FixtureAgent({ sendUnknownMethod: 'future/capability' });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      expect(client.closed).toBe(false);
      // A later request still works — the unknown method did not take the connection down.
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      expect(typeof sessionId).toBe('string');
    });

    await it('every terminal/* method in UNSUPPORTED_AGENT_METHODS is refused by the same generic branch', async () => {
      for (const method of Object.values(UNSUPPORTED_AGENT_METHODS)) {
        const fixture = new FixtureAgent({ sendUnknownMethod: method });
        const { transport, sentLines } = loggingTransport(fixture.transport);
        const client = new AcpClient({ transport });
        await client.initialize();
        const refusal = sentLines.map((line) => JSON.parse(line)).find((m) => 'error' in m) as
          | { error: { code: number } }
          | undefined;
        expect(refusal?.error.code).toBe(ERROR_CODES.METHOD_NOT_FOUND);
        expect(client.closed).toBe(false);
      }
    });
  });

  await describe('A session is a scope, not a permission — the assertScopeIsNotAuthority canary', async () => {
    await it('throws for every authority key', async () => {
      for (const key of ['allow', 'allowed', 'permissions', 'grants', 'capabilities', 'policy']) {
        expect(() => assertScopeIsNotAuthority({ [key]: [] })).toThrow();
      }
    });

    await it('does not throw for keys that describe scope, not authority', async () => {
      for (const key of ['boundTo', 'principal', 'cwd', 'reattach']) {
        expect(() => assertScopeIsNotAuthority({ [key]: 'x' })).not.toThrow();
      }
    });

    await it('a SessionRecord from newSession() carries none of the authority keys — TypeScript cannot catch {...session, grants: []}, this canary does', async () => {
      const record = newSession({
        id: 'ses_1',
        agent: 'opencode',
        cwd: '/tmp',
        at: '2026-09-30T00:00:00.000Z',
      });
      for (const key of ['allow', 'allowed', 'permissions', 'grants', 'capabilities', 'policy']) {
        expect(key in record).toBe(false);
      }
    });
  });

  await describe('Unknown _meta is never an error', async () => {
    await it('chattyMeta plus a sessionCapabilities.fork marker the v1 schema does not define works normally', async () => {
      const fixture = new FixtureAgent({
        chattyMeta: true,
        capabilities: { sessionCapabilities: { resume: {}, fork: {} } },
      });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      expect(client.supportsResumeSession).toBe(true);
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      expect(typeof sessionId).toBe('string');
    });
  });

  await describe('An unknown sessionUpdate variant is not an error', async () => {
    await it('reaches onWireMessage, not onSessionUpdate, and the connection survives', async () => {
      const fixture = new FixtureAgent();
      const { transport, inject } = injectableTransport(fixture.transport);
      const client = new AcpClient({ transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });

      const wireMessages: unknown[] = [];
      const sessionUpdates: string[] = [];
      client.onWireMessage((m) => wireMessages.push(m));
      client.onSessionUpdate((n) => sessionUpdates.push(n.update.sessionUpdate));

      inject(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'diff_preview', path: '/tmp/x' } },
        })}\n`,
      );

      expect(wireMessages.length).toBe(1);
      expect(sessionUpdates.length).toBe(0);
      expect(client.closed).toBe(false);
    });
  });

  await describe('KURIER_CLIENT_CAPABILITIES and KURIER_IMPLEMENTATION', async () => {
    await it('match what the plan requires', async () => {
      expect(KURIER_CLIENT_CAPABILITIES.fs).toStrictEqual({ readTextFile: false, writeTextFile: false });
      expect(KURIER_CLIENT_CAPABILITIES.terminal).toBe(false);
      expect(KURIER_IMPLEMENTATION.name).toBe('kurier');
      expect(typeof KURIER_IMPLEMENTATION.version).toBe('string');
    });
  });

  await describe('classifyAuthMethods — trap 1', async () => {
    await it('the measured opencode shape (no type tag) classifies as agent, not terminal', async () => {
      // Real wire shape, cast because `kind` is what kurier *derives*, never what the agent sends.
      const measured = {
        id: 'opencode-login',
        name: 'Login with opencode',
        description: 'Run `opencode auth login` in the terminal',
      } as unknown as AuthMethodInfo;
      const result = classifyAuthMethods([measured]);
      expect(result.agent.length).toBe(1);
      expect(result.terminal.length).toBe(0);
      expect(result.none).toBe(false);
    });

    await it('a method with args classifies as terminal', async () => {
      const withArgs: AuthMethodInfo = { id: 'x', name: 'X', kind: 'agent', args: ['login'] };
      const result = classifyAuthMethods([withArgs]);
      expect(result.terminal.length).toBe(1);
      expect(result.agent.length).toBe(0);
    });

    await it('an empty list (or none at all) reports none: true', async () => {
      expect(classifyAuthMethods([]).none).toBe(true);
      expect(classifyAuthMethods(undefined).none).toBe(true);
    });
  });
};
