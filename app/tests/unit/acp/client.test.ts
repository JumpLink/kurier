import { describe, expect, it } from '@gjsify/unit';

import { AcpClient, ProtocolVersionMismatchError, UnsupportedCapabilityError } from '@lotse/acp/client';
import type { Transport } from '@lotse/acp/transport';

import { FixtureAgent } from '../../support/fixture-agent.ts';

/** A minimal hand-built transport, for the one case a FixtureAgent cannot drive: a spurious
 * response to an id the client never sent. */
function manualTransport(): { transport: Transport; deliver: (data: string) => void; written: string[] } {
  let onMessage: (data: string) => void = () => {};
  const written: string[] = [];
  const transport: Transport = {
    get closed() {
      return false;
    },
    write: (data) => written.push(data),
    onMessage: (listener) => {
      onMessage = listener;
    },
    onClose: () => {},
    close: () => {},
  };
  return { transport, written, deliver: (data: string) => onMessage(data) };
}

export default async () => {
  await describe('AcpClient — initialize', async () => {
    await it('sends fs.readTextFile=false, fs.writeTextFile=false and terminal=false on the wire', async () => {
      // Guardrail 3: this must be a real assertion on what the fixture RECEIVED, not on the
      // LOTSE_CLIENT_CAPABILITIES constant re-imported into the test.
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const sent = fixture.calls('initialize')[0]?.params as {
        clientCapabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
      };
      expect(sent.clientCapabilities.fs.readTextFile).toBe(false);
      expect(sent.clientCapabilities.fs.writeTextFile).toBe(false);
      expect(sent.clientCapabilities.terminal).toBe(false);
    });

    await it('rejects with ProtocolVersionMismatchError and closes on a version it does not implement', async () => {
      const fixture = new FixtureAgent({ protocolVersion: 2 });
      const client = new AcpClient({ transport: fixture.transport });
      await expect(client.initialize()).rejects.toThrow(
        ProtocolVersionMismatchError as unknown as typeof Error,
      );
      expect(client.closed).toBe(true);
    });

    await it('exposes agentInfo and authMethods after initialize; initialized throws before', async () => {
      const fixture = new FixtureAgent({
        authMethods: [{ id: 'opencode-login', name: 'Login with opencode', kind: 'agent' }],
      });
      const client = new AcpClient({ transport: fixture.transport });
      expect(() => client.initialized).toThrow();
      await client.initialize();
      expect(client.agentInfo).toStrictEqual({ name: 'FixtureAgent', version: '0.1.0' });
      expect(client.authMethods).toStrictEqual([
        { id: 'opencode-login', name: 'Login with opencode', kind: 'agent' },
      ]);
    });

    await it('a hangOnInitialize peer times out rather than hanging forever', async () => {
      const fixture = new FixtureAgent({ hangOnInitialize: true });
      const client = new AcpClient({ transport: fixture.transport, initializeTimeoutMs: 50 });
      await expect(client.initialize()).rejects.toThrow(/did not answer within/);
    });
  });

  await describe('AcpClient — session/new and the unprompted notification', async () => {
    await it('returns the session id and delivers available_commands_update to onSessionUpdate, not the wire listener', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const updates: string[] = [];
      const wire: string[] = [];
      client.onSessionUpdate((n) => updates.push(n.update.sessionUpdate));
      client.onWireMessage((m) => wire.push(m.method));
      const { sessionId } = await client.newSession({ cwd: '/tmp/lotse-test', mcpServers: [] });
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length > 0).toBe(true);
      expect(updates).toContain('available_commands_update');
      expect(wire.includes('session/update')).toBe(false);
    });
  });

  await describe('AcpClient — session/prompt', async () => {
    await it('streams agent_message_chunk updates in order and settles on stopReason', async () => {
      const fixture = new FixtureAgent({ chunks: ['first', 'second', 'third'] });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const texts: string[] = [];
      client.onSessionUpdate((n) => {
        if (n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text') {
          texts.push(n.update.content.text);
        }
      });
      const response = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(texts).toStrictEqual(['first', 'second', 'third']);
      expect(response.stopReason).toBe('end_turn');
    });
  });

  await describe('AcpClient — session/cancel', async () => {
    await it('is a notification the fixture records, and the turn settles with cancelled', async () => {
      // requestFileSystem gives the fixture's turn a real await gap to cancel inside; without
      // one, a turn with no permission/fs step runs to completion synchronously and there is no
      // window to send session/cancel before the agent has already answered.
      const fixture = new FixtureAgent({ requestFileSystem: 'read' });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const promptPromise = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      expect(fixture.turnRunning).toBe(true);
      client.cancel({ sessionId });
      const response = await promptPromise;
      expect(response.stopReason).toBe('cancelled');
      expect(fixture.calls('session/cancel').length).toBe(1);
    });
  });

  await describe('AcpClient — session/list pagination', async () => {
    await it('follows nextCursor to the end: listPages 3 yields three sessions and nextCursor null', async () => {
      const fixture = new FixtureAgent({ listPages: 3 });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const result = await client.listSessions();
      expect(result.sessions.length).toBe(3);
      expect(result.nextCursor ?? null).toBe(null);
    });

    await it('maxPages stops the walk instead of looping on a peer that keeps handing back a cursor', async () => {
      const fixture = new FixtureAgent({ listPages: 1000 });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const result = await client.listSessions({}, { maxPages: 2 });
      expect(result.sessions.length).toBe(2);
    });
  });

  await describe('AcpClient — reattach: trap 2, check the capability, do not assume it', async () => {
    await it('prefers session/load when the agent advertises loadSession: true', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      await client.reattach('some-session', { cwd: '/tmp' });
      expect(fixture.calls('session/load').length).toBe(1);
      expect(fixture.calls('session/resume').length).toBe(0);
    });

    await it('falls back to session/resume when the agent only offers resume', async () => {
      const fixture = new FixtureAgent({ omitLoadSession: true });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      await client.reattach('some-session', { cwd: '/tmp' });
      expect(fixture.calls('session/load').length).toBe(0);
      expect(fixture.calls('session/resume').length).toBe(1);
    });

    await it('rejects with UnsupportedCapabilityError when the agent offers neither', async () => {
      const fixture = new FixtureAgent({ capabilities: { loadSession: false, sessionCapabilities: {} } });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      await expect(client.reattach('some-session', { cwd: '/tmp' })).rejects.toThrow(
        UnsupportedCapabilityError as unknown as typeof Error,
      );
      expect(fixture.calls('session/load').length).toBe(0);
      expect(fixture.calls('session/resume').length).toBe(0);
    });
  });

  await describe('AcpClient — closeSession / deleteSession capability checks', async () => {
    await it('rejects with UnsupportedCapabilityError when the marker is absent', async () => {
      const fixture = new FixtureAgent({ capabilities: { sessionCapabilities: {} } });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      await expect(client.closeSession({ sessionId: 'x' })).rejects.toThrow(
        UnsupportedCapabilityError as unknown as typeof Error,
      );
      await expect(client.deleteSession({ sessionId: 'x' })).rejects.toThrow(
        UnsupportedCapabilityError as unknown as typeof Error,
      );
    });

    await it('succeeds when the marker is present', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      await client.closeSession({ sessionId });
      await client.deleteSession({ sessionId });
      expect(fixture.calls('session/close').length).toBe(1);
      expect(fixture.calls('session/delete').length).toBe(1);
    });
  });

  await describe('AcpClient — a vanished peer', async () => {
    await it('rejects every pending request, including a session/prompt in flight', async () => {
      const fixture = new FixtureAgent({ requestFileSystem: 'read' });
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      const { sessionId } = await client.newSession({ cwd: '/tmp', mcpServers: [] });
      const promptPromise = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });
      fixture.vanish();
      await expect(promptPromise).rejects.toThrow();
      expect(client.closed).toBe(true);
    });
  });

  await describe('AcpClient — connection lifecycle', async () => {
    await it('closing twice is a no-op; sending after close throws', async () => {
      const fixture = new FixtureAgent();
      const client = new AcpClient({ transport: fixture.transport });
      await client.initialize();
      client.close();
      client.close();
      expect(() => client.cancel({ sessionId: 'x' })).toThrow();
      await expect(client.prompt({ sessionId: 'x', prompt: [] })).rejects.toThrow();
    });

    await it('closes the connection when a write fails, whichever direction it was going', async () => {
      const broken = (): Transport => ({
        get closed() {
          return false;
        },
        write: () => {
          throw new Error('EPIPE');
        },
        onMessage: () => {},
        onClose: () => {},
        close: () => {},
      });
      // A notification lotse sends: the caller hears about it, and the client knows it is closed.
      const notifying = new AcpClient({ transport: broken() });
      expect(() => notifying.cancel({ sessionId: 'x' })).toThrow(/EPIPE/);
      expect(notifying.closed).toBe(true);
      // A request lotse sends: the promise rejects, and the client is closed the same way.
      const requesting = new AcpClient({ transport: broken() });
      await expect(requesting.newSession({ cwd: '/tmp', mcpServers: [] })).rejects.toThrow(/EPIPE/);
      expect(requesting.closed).toBe(true);
    });

    await it('ignores a response to an unknown id rather than treating it as an error', async () => {
      const { transport, deliver } = manualTransport();
      const client = new AcpClient({ transport });
      deliver('{"jsonrpc":"2.0","id":999999,"result":{}}\n');
      expect(client.closed).toBe(false);
    });
  });
};
