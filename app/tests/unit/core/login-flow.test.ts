/** One login, driven by a scripted API and a fake clock — no process, no network, no sleeping. */

import { describe, expect, it } from '@gjsify/unit';

import {
  EXPIRY_GRACE_MS,
  MAX_POLL_FAILURES,
  POLL_MS,
  answersFor,
  runLogin,
  type LoginApi,
  type LoginHooks,
  type LoginMode,
  type OAuthStatus,
} from '@kurier/core';

interface Script {
  mode?: LoginMode;
  /** Returned in order; an `Error` is thrown. The last entry repeats. */
  statuses: Array<OAuthStatus | Error>;
  expiresIn?: number;
  completeError?: Error;
}

function harness(script: Script) {
  const calls: string[] = [];
  let at = 0;
  let clock = 1_000;
  const api: LoginApi = {
    async begin(providerId, methodId, answer) {
      calls.push(`begin ${providerId}/${methodId} ${JSON.stringify(answer)}`);
      return {
        attemptId: 'att_1',
        url: 'https://login.example/device',
        instructions: 'Enter code: AAAA-BBBB',
        mode: script.mode ?? 'auto',
        expiresAt: clock + (script.expiresIn ?? 600_000),
      };
    },
    async status() {
      calls.push('status');
      const next = script.statuses[Math.min(at, script.statuses.length - 1)]!;
      at += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async complete(_p, _a, code) {
      calls.push(`complete ${code}`);
      if (script.completeError) throw script.completeError;
    },
    async cancel() {
      calls.push('cancel');
    },
  };
  const shown: string[] = [];
  let cancelled = false;
  let code: string | null = ' 1234 ';
  const hooks: LoginHooks = {
    show: (prompt) => shown.push(`${prompt.mode} ${prompt.url} | ${prompt.instructions}`),
    askCode: async () => code,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
      clock += ms;
    },
    now: () => clock,
    isCancelled: () => cancelled,
  };
  return {
    api,
    hooks,
    calls,
    shown,
    cancelNow: () => (cancelled = true),
    typeCode: (value: string | null) => (code = value),
    jump: (ms: number) => (clock += ms),
  };
}

const PENDING: OAuthStatus = { status: 'pending' };
const DONE: OAuthStatus = { status: 'complete' };

export default async () => {
  await describe('runLogin — auto mode', async () => {
    await it('shows the URL and the instructions once, then polls until complete', async () => {
      const h = harness({ statuses: [PENDING, PENDING, DONE] });
      const result = await runLogin(h.api, 'openai', 'chatgpt-headless', {}, h.hooks);
      expect(result.kind).toBe('connected');
      expect(h.shown.length).toBe(1);
      expect(h.shown[0]).toBe('auto https://login.example/device | Enter code: AAAA-BBBB');
      expect(h.calls.filter((c) => c === 'status').length).toBe(3);
      expect(h.calls.filter((c) => c === `sleep ${POLL_MS}`).length).toBe(2);
    });

    await it('sends the answers it was given with the begin call', async () => {
      const h = harness({ statuses: [DONE] });
      await runLogin(h.api, 'github-copilot', 'device', { deploymentType: 'github.com' }, h.hooks);
      expect(h.calls[0]).toBe('begin github-copilot/device {"deploymentType":"github.com"}');
    });

    await it("reports the provider's own failure message", async () => {
      const h = harness({ statuses: [PENDING, { status: 'failed', message: 'access denied' }] });
      const result = await runLogin(h.api, 'poe', 'browser', {}, h.hooks);
      expect(result.kind === 'failed' && result.message).toBe('access denied');
    });

    await it('reports an expired attempt, and does not cancel what is already over', async () => {
      const h = harness({ statuses: [{ status: 'expired' }] });
      const result = await runLogin(h.api, 'poe', 'browser', {}, h.hooks);
      expect(result.kind).toBe('expired');
      expect(h.calls.includes('cancel')).toBe(false);
    });

    await it('stops waiting on its own clock once the attempt is past its expiry, and cancels it', async () => {
      const h = harness({ statuses: [PENDING], expiresIn: 5_000 });
      h.jump(5_000 + EXPIRY_GRACE_MS + 1);
      const result = await runLogin(h.api, 'poe', 'browser', {}, h.hooks);
      expect(result.kind).toBe('expired');
      expect(h.calls.includes('cancel')).toBe(true);
    });

    await it('turns a cancelled window into a cancelled attempt, not a dangling one', async () => {
      const h = harness({ statuses: [PENDING] });
      h.cancelNow();
      const result = await runLogin(h.api, 'poe', 'browser', {}, h.hooks);
      expect(result.kind).toBe('cancelled');
      expect(h.calls.includes('cancel')).toBe(true);
      expect(h.calls.includes('status')).toBe(false);
    });

    await it('survives a failed poll or two and gives up on the third in a row', async () => {
      const flaky = harness({ statuses: [new Error('reset'), new Error('reset'), DONE] });
      expect((await runLogin(flaky.api, 'poe', 'browser', {}, flaky.hooks)).kind).toBe('connected');

      const dead = harness({ statuses: [new Error('connection refused')] });
      const result = await runLogin(dead.api, 'poe', 'browser', {}, dead.hooks);
      expect(result.kind === 'failed' && result.message).toBe('connection refused');
      expect(dead.calls.filter((c) => c === 'status').length).toBe(MAX_POLL_FAILURES);
    });
  });

  await describe('runLogin — code mode', async () => {
    await it('hands the trimmed pasted code to complete, then reads the status', async () => {
      const h = harness({ mode: 'code', statuses: [DONE] });
      const result = await runLogin(h.api, 'openai', 'chatgpt-browser', {}, h.hooks);
      expect(result.kind).toBe('connected');
      expect(h.calls.includes('complete 1234')).toBe(true);
    });

    await it('cancels when nobody pastes a code', async () => {
      for (const nothing of [null, '', '   ']) {
        const h = harness({ mode: 'code', statuses: [DONE] });
        h.typeCode(nothing);
        const result = await runLogin(h.api, 'openai', 'chatgpt-browser', {}, h.hooks);
        expect(result.kind).toBe('cancelled');
        expect(h.calls.includes('cancel')).toBe(true);
        expect(h.calls.some((c) => c.startsWith('complete'))).toBe(false);
      }
    });

    await it('fails with the reason when the provider refuses the code', async () => {
      const h = harness({ mode: 'code', statuses: [DONE], completeError: new Error('code does not match') });
      const result = await runLogin(h.api, 'openai', 'chatgpt-browser', {}, h.hooks);
      expect(result.kind === 'failed' && result.message).toBe('code does not match');
    });
  });

  await describe('answersFor', async () => {
    const copilot = {
      fields: [
        { key: 'deploymentType', title: 'Type', required: true, hidden: false },
        {
          key: 'enterpriseUrl',
          title: 'URL',
          required: true,
          hidden: false,
          when: [{ key: 'deploymentType', value: 'enterprise' }],
        },
      ],
    };

    await it('asks for a required field nobody answered', async () => {
      const { answer, missing } = answersFor(copilot, {});
      expect(missing.map((f) => f.key).join(',')).toBe('deploymentType');
      expect(Object.keys(answer).length).toBe(0);
    });

    await it('skips a conditional field while its condition is not met', async () => {
      const { answer, missing } = answersFor(copilot, { deploymentType: 'github.com' });
      expect(missing.length).toBe(0);
      expect(JSON.stringify(answer)).toBe('{"deploymentType":"github.com"}');
    });

    await it('asks for it once the condition is met', async () => {
      const { missing } = answersFor(copilot, { deploymentType: 'enterprise' });
      expect(missing.map((f) => f.key).join(',')).toBe('enterpriseUrl');
    });

    await it('fills a hidden or defaulted field from its default and sends an empty optional one as nothing', async () => {
      const method = {
        fields: [
          { key: 'server', title: 'Server', required: false, hidden: true, default: 'https://x.example' },
          { key: 'role', title: 'Role', required: false, hidden: false },
        ],
      };
      const { answer, missing } = answersFor(method, { role: '' });
      expect(JSON.stringify(answer)).toBe('{"server":"https://x.example"}');
      expect(missing.length).toBe(0);
    });
  });
};
