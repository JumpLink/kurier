/** The dialog's logic, driven through a scripted session — no server, no widget, no waiting. */

import { describe, expect, it } from '@gjsify/unit';

import {
  LoginController,
  type LoginMethod,
  type LoginMode,
  type LoginProvider,
  type LoginSession,
  type LoginState,
  type OAuthStatus,
} from '@lotse/core';

const DEVICE: LoginMethod = { id: 'device', kind: 'oauth', label: 'Device code', fields: [] };
const KEY: LoginMethod = { id: 'key', kind: 'key', label: 'API key', fields: [] };
const WITH_FIELD: LoginMethod = {
  id: 'enterprise',
  kind: 'oauth',
  label: 'Enterprise',
  fields: [{ key: 'host', title: 'Host', kind: 'text', required: true } as never],
};
const POE: LoginProvider = {
  id: 'poe',
  name: 'Poe',
  connected: false,
  featured: false,
  europe: false,
  methods: [DEVICE],
};
const SCALEWAY: LoginProvider = {
  id: 'scaleway',
  name: 'Scaleway',
  connected: false,
  featured: true,
  europe: true,
  methods: [KEY],
};
const COPILOT: LoginProvider = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  connected: false,
  featured: true,
  europe: false,
  methods: [DEVICE, WITH_FIELD],
};

function harness(
  options: {
    keyError?: string;
    mode?: LoginMode;
    statuses?: OAuthStatus[];
    unavailable?: string | null;
  } = {},
) {
  const calls: string[] = [];
  const statuses = options.statuses ?? [{ status: 'complete' }];
  let at = 0;
  const session: LoginSession = {
    async providers() {
      calls.push('providers');
      return [POE, COPILOT, SCALEWAY];
    },
    async connectKey(p, key, answer) {
      calls.push(`key ${p} ${key.length} ${JSON.stringify(answer)}`);
      if (options.keyError) throw new Error(options.keyError);
    },
    async begin(p, m, answer) {
      calls.push(`begin ${p}/${m} ${JSON.stringify(answer)}`);
      return {
        attemptId: 'a1',
        url: 'https://login.example',
        instructions: 'Enter AAAA',
        mode: options.mode ?? 'auto',
        expiresAt: 10 ** 12,
      };
    },
    async status() {
      return statuses[Math.min(at++, statuses.length - 1)]!;
    },
    async complete(_p, _a, code) {
      calls.push(`complete ${code}`);
    },
    async cancel() {
      calls.push('cancel');
    },
    async close() {
      calls.push('close');
    },
  };
  const controller = new LoginController({
    openSession: async () => {
      calls.push('open');
      return session;
    },
    unavailableReason: () => options.unavailable ?? null,
    sleep: async () => undefined,
    now: () => 1_000,
    onConnected: (provider) => {
      calls.push(`connected ${provider.id}`);
    },
  });
  const steps: string[] = [];
  controller.subscribe((state: LoginState) => steps.push(state.step));
  return { controller, calls, steps };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export default async () => {
  await describe('LoginController', async () => {
    await it('offers a terminal hint and starts nothing when no server can be had', async () => {
      const h = harness({ unavailable: 'use kurier auth' });
      await h.controller.open();
      expect(h.controller.state.step).toBe('unavailable');
      expect(h.calls.includes('open')).toBe(false);
    });

    await it('asks for a key, hands it over once and ends connected, with the agent restarted', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickProvider(SCALEWAY);
      expect(h.controller.state.step).toBe('key');
      await h.controller.submitKey(SCALEWAY, '  sk-synthetic  ');
      expect(h.calls.filter((c) => c.startsWith('key ')).join()).toBe('key scaleway 12 {}');
      expect(h.calls.includes('connected scaleway')).toBe(true);
      expect(h.controller.state.step).toBe('connected');
    });

    await it('ignores a blank key and never puts the key in the state', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickProvider(SCALEWAY);
      await h.controller.submitKey(SCALEWAY, '   ');
      expect(h.controller.state.step).toBe('key');
      await h.controller.submitKey(SCALEWAY, 'sk-secret-synthetic');
      expect(JSON.stringify(h.controller.state).includes('sk-secret-synthetic')).toBe(false);
    });

    await it('a second submit while the first is in flight stores and restarts once', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickProvider(SCALEWAY);
      await Promise.all([
        h.controller.submitKey(SCALEWAY, 'sk-synthetic'),
        h.controller.submitKey(SCALEWAY, 'sk-synthetic'),
      ]);
      expect(h.calls.filter((c) => c.startsWith('key ')).length).toBe(1);
      expect(h.calls.filter((c) => c.startsWith('connected')).length).toBe(1);
    });

    await it('keeps one provider’s form answers out of another provider’s key call', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickMethod(SCALEWAY, { ...KEY, fields: [] });
      await h.controller.submitKey(SCALEWAY, 'sk-a');
      await h.controller.pickProvider(SCALEWAY);
      await h.controller.submitKey(SCALEWAY, 'sk-b');
      expect(h.calls.filter((c) => c.startsWith('key ')).every((c) => c.endsWith('{}'))).toBe(true);
    });

    await it('reports a rejected key as a failure and does not restart the agent', async () => {
      const h = harness({ keyError: 'invalid key sk-secret-synthetic' });
      await h.controller.open();
      await h.controller.pickProvider(SCALEWAY);
      await h.controller.submitKey(SCALEWAY, 'sk-secret-synthetic');
      const state = h.controller.state;
      expect(state.step).toBe('failed');
      if (state.step === 'failed') expect(state.message.includes('sk-secret-synthetic')).toBe(false);
      expect(h.calls.some((c) => c.startsWith('connected'))).toBe(false);
    });

    await it('a second open does not start a second server', async () => {
      const h = harness();
      await Promise.all([h.controller.open(), h.controller.open()]);
      expect(h.calls.filter((c) => c === 'open').length).toBe(1);
    });

    await it('lists the providers after the server is up', async () => {
      const h = harness();
      await h.controller.open();
      expect(h.steps.join()).toBe('starting,providers');
    });

    await it('goes straight into a provider with one method and restarts the agent on success', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickProvider(POE);
      expect(h.controller.state.step).toBe('connected');
      expect(h.calls.includes('begin poe/device {}')).toBe(true);
      expect(h.calls.includes('connected poe')).toBe(true);
      expect(h.steps.join()).toBe('starting,providers,beginning,waiting,connected');
    });

    await it('asks for the choice when a provider has several methods', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickProvider(COPILOT);
      expect(h.controller.state.step).toBe('methods');
    });

    await it('asks for a required field before it begins, and sends the answer', async () => {
      const h = harness();
      await h.controller.open();
      await h.controller.pickMethod(COPILOT, WITH_FIELD);
      expect(h.controller.state.step).toBe('fields');
      expect(h.calls.some((c) => c.startsWith('begin'))).toBe(false);
      await h.controller.submitFields(COPILOT, WITH_FIELD, { host: 'corp.example' });
      expect(h.calls.includes('begin github-copilot/enterprise {"host":"corp.example"}')).toBe(true);
      expect(h.controller.state.step).toBe('connected');
    });

    await it('shows the provider failure and does not call the restart', async () => {
      const h = harness({ statuses: [{ status: 'failed', message: 'denied' }] });
      await h.controller.open();
      await h.controller.pickProvider(POE);
      const state = h.controller.state;
      expect(state.step === 'failed' && state.message).toBe('denied');
      expect(h.calls.some((c) => c.startsWith('connected'))).toBe(false);
    });

    await it('collects a pasted code in code mode and ignores a blank one', async () => {
      const h = harness({ mode: 'code', statuses: [{ status: 'complete' }] });
      await h.controller.open();
      const running = h.controller.pickProvider(POE);
      await tick();
      expect(h.controller.state.step).toBe('waiting');
      h.controller.submitCode('   ');
      await tick();
      expect(h.controller.state.step).toBe('waiting');
      h.controller.submitCode(' 1234 ');
      await running;
      expect(h.calls.includes('complete 1234')).toBe(true);
      expect(h.controller.state.step).toBe('connected');
    });

    await it('cancelling a pending attempt cancels it at the provider and goes back to the list', async () => {
      const h = harness({ mode: 'code' });
      await h.controller.open();
      const running = h.controller.pickProvider(POE);
      await tick();
      h.controller.cancel();
      await running;
      await tick();
      expect(h.calls.includes('cancel')).toBe(true);
      expect(h.controller.state.step).toBe('providers');
    });

    await it('closing mid-attempt stops the server, stays closed and never reports connected', async () => {
      const h = harness({ mode: 'code' });
      await h.controller.open();
      const running = h.controller.pickProvider(POE);
      await tick();
      await h.controller.close();
      await running;
      await tick();
      expect(h.controller.state.step).toBe('closed');
      expect(h.calls.filter((c) => c === 'close').length).toBe(1);
      await h.controller.close();
      expect(h.calls.filter((c) => c === 'close').length).toBe(1);
    });
  });
};
