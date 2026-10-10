/**
 * Which page a chat shows when the agent may have no provider behind it. Pure, plus the probe over a fake session.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  connectionFacts,
  onboardingView,
  probeConnections,
  type AgentCommand,
  type ConnectionFacts,
  type LoginMethod,
  type LoginProvider,
  type LoginSession,
  type OnboardingInput,
} from '@kurier/core';

const method = (kind: 'oauth' | 'key'): LoginMethod => ({ id: kind, kind, label: kind, fields: [] });
const provider = (id: string, kinds: ('oauth' | 'key')[], connected = false): LoginProvider => ({
  id,
  name: id,
  connected,
  featured: false,
  europe: false,
  methods: kinds.map(method),
});

const NONE: ConnectionFacts = { kind: 'none', browser: 2, key: 5 };
const BASE: OnboardingInput = {
  enabled: true,
  noAgent: false,
  loginAvailable: true,
  connection: NONE,
  dismissed: false,
};
const AGENT: AgentCommand = { id: 'opencode', title: 'OpenCode', program: 'opencode', args: ['acp'] };

function fakeSession(providers: () => Promise<LoginProvider[]>, closed: string[]): LoginSession {
  const never = () => Promise.reject(new Error('not used'));
  return {
    providers,
    connectKey: never,
    begin: never,
    status: never,
    complete: never,
    cancel: never,
    close: async () => {
      closed.push('closed');
    },
  } as LoginSession;
}

export default async () => {
  await describe('connectionFacts', async () => {
    await it('is unknown for an empty catalog', async () => {
      expect(connectionFacts([]).kind).toBe('unknown');
    });

    await it('is connected as soon as one provider is', async () => {
      expect(connectionFacts([provider('a', ['key']), provider('b', ['key'], true)]).kind).toBe('connected');
    });

    await it('counts the providers behind each way in when nothing is connected', async () => {
      const facts = connectionFacts([
        provider('a', ['oauth', 'key']),
        provider('b', ['key']),
        provider('c', ['key']),
      ]);
      expect(JSON.stringify(facts)).toBe(JSON.stringify({ kind: 'none', browser: 1, key: 3 }));
    });
  });

  await describe('onboardingView', async () => {
    await it('shows the page when nothing is connected and a login can run', async () => {
      const view = onboardingView(BASE);
      expect(view?.title).toBe('Connect a provider');
      expect(view?.paths.map((path) => path.label).join()).toBe('Browser login,API key');
      expect(view?.paths[0]?.detail).toBe('2 providers');
    });

    await it('labels the free models as free, hosted and time-limited', async () => {
      const view = onboardingView(BASE);
      expect(view?.free).toContain('free hosted');
      expect(view?.freeNote).toContain('time-limited');
    });

    await it('omits a way in no provider offers, and says "1 provider" in the singular', async () => {
      const view = onboardingView({ ...BASE, connection: { kind: 'none', browser: 0, key: 1 } });
      expect(JSON.stringify(view?.paths)).toBe(JSON.stringify([{ label: 'API key', detail: '1 provider' }]));
    });

    await it('stays away when the host did not ask for it', async () => {
      expect(onboardingView({ ...BASE, enabled: false })).toBeNull();
    });

    await it('stays away without an agent, where the no-agent page wins', async () => {
      expect(onboardingView({ ...BASE, noAgent: true })).toBeNull();
    });

    await it('stays away where no login can run', async () => {
      expect(onboardingView({ ...BASE, loginAvailable: false })).toBeNull();
    });

    await it('fails closed on unknown connection state', async () => {
      expect(onboardingView({ ...BASE, connection: { kind: 'unknown' } })).toBeNull();
    });

    await it('stays away once a provider is connected', async () => {
      expect(onboardingView({ ...BASE, connection: { kind: 'connected' } })).toBeNull();
    });

    await it('stays away after the person chose the free models', async () => {
      expect(onboardingView({ ...BASE, dismissed: true })).toBeNull();
    });
  });

  await describe('probeConnections', async () => {
    await it('is unknown without starting anything when no login can run', async () => {
      let opened = false;
      const facts = await probeConnections(AGENT, {
        reason: () => 'no',
        open: async () => {
          opened = true;
          throw new Error('unreachable');
        },
      });
      expect(facts.kind).toBe('unknown');
      expect(opened).toBe(false);
    });

    await it('reads the catalog and closes the server', async () => {
      const closed: string[] = [];
      const facts = await probeConnections(AGENT, {
        reason: () => null,
        open: async () => fakeSession(async () => [provider('a', ['key'])], closed),
      });
      expect(JSON.stringify(facts)).toBe(JSON.stringify({ kind: 'none', browser: 0, key: 1 }));
      expect(closed.length).toBe(1);
    });

    await it('is unknown when the server cannot start, and when the catalog cannot be read', async () => {
      const closed: string[] = [];
      expect(
        (await probeConnections(AGENT, { reason: () => null, open: () => Promise.reject(new Error('x')) }))
          .kind,
      ).toBe('unknown');
      const facts = await probeConnections(AGENT, {
        reason: () => null,
        open: async () => fakeSession(() => Promise.reject(new Error('x')), closed),
      });
      expect(facts.kind).toBe('unknown');
      expect(closed.length).toBe(1);
    });
  });
};
