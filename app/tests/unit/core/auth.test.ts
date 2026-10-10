/**
 * The login an agent asks for: the plan, the sentences, and the order of the two handshakes.
 *
 * No process anywhere. `arrangeAuth` takes its `open` and its `runLogin` as hooks, so the sequence runs
 * against a `FixtureAgent` over an injected transport and a login that is only an exit code — which is
 * what makes "the agent is asked again afterwards" a measurement rather than a comment in the file.
 */

import { describe, expect, it } from '@gjsify/unit';

import { AcpClient } from '@lotse/acp/client';
import { DENY_EVERYTHING, classifyAuthMethods } from '@lotse/acp/gate';
import type { AuthMethodInfo } from '@lotse/acp/types';

import {
  OPENCODE_COMMAND,
  arrangeAuth,
  authPlan,
  describeAuthMethod,
  describeAuthMethods,
  loginCommandFor,
  type AgentCommand,
  type AuthArrangement,
} from '@lotse/core';
import { FixtureAgent } from '../../support/fixture-agent.ts';

/** A method the agent tagged, so it can run the login in a terminal it already owns. */
const TERMINAL: AuthMethodInfo = { id: 'opencode-terminal', name: 'Terminal login', kind: 'terminal' };

/** opencode 2.0.19's own shape: no tag, and a `description` the v1 schema does not define. */
const AGENT: AuthMethodInfo = {
  id: 'opencode-login',
  name: 'Login with opencode',
  description: 'Run `opencode auth login` in the terminal',
  kind: 'agent',
};

/** Advertised, but with nothing a client could name in `authenticate`. Not the same as none. */
const NAMELESS: AuthMethodInfo = { id: '', name: 'Login with something', kind: 'agent' };

const BUNDLED: AgentCommand = {
  id: 'opencode',
  title: 'OpenCode (bundled)',
  program: '/app/extra/agents/opencode/bin/opencode',
  args: ['acp'],
  bundled: true,
  env: { HOME: '/data/agents/opencode' },
};

interface Script {
  /** What every handshake advertises. Absent means the agent wants no authentication. */
  authMethods?: AuthMethodInfo[];
  /** The programs `which` finds. Everything else is missing. Defaults to `opencode`. */
  onPath?: string[];
  /** What the login command exits with. Defaults to 0. */
  loginCode?: number;
  /** Make the agent refuse `authenticate` instead of accepting it. */
  rejectAuthenticate?: boolean;
  command?: AgentCommand;
}

function harness(script: Script) {
  /** One `AgentCommand` per handshake, so "there were two, in this order" is assertable. */
  const opened: AgentCommand[] = [];
  const ranLogin: AgentCommand[] = [];
  const methods: string[] = [];
  const steps: string[] = [];
  let closed = 0;

  const run = (): Promise<AuthArrangement> =>
    arrangeAuth({
      command: script.command ?? OPENCODE_COMMAND,
      gate: DENY_EVERYTHING,
      lookup: (program) => ((script.onPath ?? ['opencode']).includes(program) ? `/usr/bin/${program}` : null),
      runLogin: async (command) => {
        ranLogin.push(command);
        return script.loginCode ?? 0;
      },
      onMethod: (method) => methods.push(describeAuthMethod(method)),
      onStep: (message) => steps.push(message),
      // A fresh peer per handshake, because the first one is closed before the second opens — which
      // is the behaviour under test, not an artefact of the harness.
      open: async (options) => {
        opened.push(options.command);
        const agent = new FixtureAgent({
          authMethods: script.authMethods ?? [],
          ...(script.rejectAuthenticate ? { rejectAuthenticate: true } : {}),
        });
        const client = new AcpClient({ transport: agent.transport, gate: options.gate });
        await client.initialize();
        return {
          client,
          logLines: [],
          agentInfo: 'FixtureAgent 0.1.0',
          close: () => {
            closed += 1;
            client.close();
          },
        };
      },
    });

  return { run, opened, ranLogin, methods, steps, closed: () => closed };
}

export default async function auth(): Promise<void> {
  await describe('authPlan', async () => {
    await it('is none for an agent that advertised nothing', () => {
      expect(authPlan(undefined).kind).toBe('none');
      expect(authPlan([]).kind).toBe('none');
    });

    await it('prefers the method the agent can run itself', () => {
      const plan = authPlan([AGENT, TERMINAL]);
      expect(plan.kind).toBe('agent-runs-it');
      expect(plan.kind === 'agent-runs-it' && plan.methodId).toBe('opencode-terminal');
      // Terminal first, which is the order a surface lists them in — not the wire order.
      expect(plan.kind !== 'none' && plan.methods.map((method) => method.id).join(',')).toBe(
        'opencode-terminal,opencode-login',
      );
    });

    await it("reads opencode's own shape as a login lotse has to arrange", () => {
      const plan = authPlan([AGENT]);
      expect(plan.kind).toBe('client-arranges-it');
      expect(plan.kind === 'client-arranges-it' && plan.methodId).toBe('opencode-login');
    });

    await it('is unusable, never none, for a method with no id', () => {
      const plan = authPlan([NAMELESS]);
      expect(plan.kind).toBe('unusable');
      expect(plan.kind === 'unusable' && plan.methods.length).toBe(1);
    });
  });

  await describe('describeAuthMethods', async () => {
    await it('names what the agent advertised and the command that arranges it', () => {
      expect(describeAuthMethods(classifyAuthMethods([AGENT]))).toBe(
        [
          'this agent advertises authentication:',
          '  Login with opencode (opencode-login) — Run `opencode auth login` in the terminal',
          '  `lotse auth` arranges it; a session started before that will fail with -32000.',
        ].join('\n'),
      );
    });

    await it('says so when the agent can run the login itself', () => {
      expect(describeAuthMethods(classifyAuthMethods([TERMINAL]))).toContain(
        'Terminal login (opencode-terminal) — the agent can run it itself',
      );
    });
  });

  await describe('describeAuthMethod', async () => {
    await it('appends the description only when there is one', () => {
      expect(describeAuthMethod(AGENT)).toBe(
        'Login with opencode (opencode-login) — Run `opencode auth login` in the terminal',
      );
      expect(describeAuthMethod(TERMINAL)).toBe('Terminal login (opencode-terminal)');
    });
  });

  await describe('loginCommandFor', async () => {
    await it("is opencode's own login for a host install", () => {
      const login = loginCommandFor(OPENCODE_COMMAND);
      expect(login.id).toBe('opencode-login');
      expect(login.program).toBe('opencode');
      expect(login.args.join(' ')).toBe('auth login');
    });

    await it("keeps the bundled copy's program and environment", () => {
      // The copy's own program with its own HOME: a login through the person's `opencode` would land
      // in their config, and the bundled agent would never see it.
      const login = loginCommandFor(BUNDLED);
      expect(login.program).toBe(BUNDLED.program);
      expect(login.env?.['HOME']).toBe('/data/agents/opencode');
      expect(login.bundled).toBe(true);
      expect(login.args.join(' ')).toBe('auth login');
    });

    await it('refuses an agent whose login it does not know', () => {
      expect(() => loginCommandFor({ ...OPENCODE_COMMAND, id: 'claude' })).toThrow(/claude/);
    });
  });

  await describe('arrangeAuth', async () => {
    await it('stops after one handshake when the agent wants no login', async () => {
      const h = harness({});
      expect((await h.run()).kind).toBe('none');
      expect(h.opened.length).toBe(1);
      expect(h.ranLogin.length).toBe(0);
      expect(h.methods.length).toBe(0);
      expect(h.closed()).toBe(1);
    });

    await it('lets the agent authenticate itself, and runs no login command', async () => {
      const h = harness({ authMethods: [TERMINAL] });
      const result = await h.run();
      expect(result.kind).toBe('authenticated');
      expect(result.kind === 'authenticated' && result.methodId).toBe('opencode-terminal');
      // `viaLogin: false` is the difference the CLI words differently: the agent did it, lotse did not.
      expect(result.kind === 'authenticated' && result.viaLogin).toBe(false);
      expect(h.opened.length).toBe(1);
      expect(h.ranLogin.length).toBe(0);
      expect(h.steps.join('')).toBe(`asking ${OPENCODE_COMMAND.title} to authenticate itself…`);
      expect(h.closed()).toBe(1);
    });

    await it('reports the methods it cannot use, and arranges nothing', async () => {
      const h = harness({ authMethods: [NAMELESS] });
      expect((await h.run()).kind).toBe('unusable');
      expect(h.methods.join('')).toBe('Login with something ()');
      expect(h.opened.length).toBe(1);
      expect(h.ranLogin.length).toBe(0);
    });

    await it('arranges the login, then asks the agent again', async () => {
      const h = harness({ authMethods: [AGENT] });
      const result = await h.run();
      expect(result.kind).toBe('authenticated');
      expect(result.kind === 'authenticated' && result.methodId).toBe('opencode-login');
      // The point of the whole sequence: `viaLogin` is the agent's own yes, on a second handshake,
      // rather than a zero exit code read as one.
      expect(result.kind === 'authenticated' && result.viaLogin).toBe(true);
      expect(h.opened.length).toBe(2);
      expect(h.ranLogin.map((command) => command.args.join(' ')).join('')).toBe('auth login');
      expect(h.methods.join('')).toBe(describeAuthMethod(AGENT));
      expect(h.steps.length).toBe(1);
      expect(h.steps[0]).toContain('running `opencode auth login`');
      expect(h.closed()).toBe(2);
    });

    await it('does not run a login that is not installed', async () => {
      const h = harness({ authMethods: [AGENT], onPath: [] });
      const result = await h.run();
      expect(result.kind).toBe('login-missing');
      expect(result.kind === 'login-missing' && result.command.program).toBe('opencode');
      expect(h.ranLogin.length).toBe(0);
      // No second handshake: nothing happened that the agent could have a new answer about.
      expect(h.opened.length).toBe(1);
      expect(h.steps.length).toBe(0);
    });

    await it("carries the login's exit code and asks nothing further", async () => {
      const h = harness({ authMethods: [AGENT], loginCode: 3 });
      const result = await h.run();
      expect(result.kind).toBe('login-failed');
      expect(result.kind === 'login-failed' && result.code).toBe(3);
      expect(h.opened.length).toBe(1);
    });

    await it('believes the agent over the exit code when it refuses', async () => {
      const h = harness({ authMethods: [AGENT], rejectAuthenticate: true });
      const result = await h.run();
      expect(result.kind).toBe('refused');
      expect(result.kind === 'refused' && result.methodId).toBe('opencode-login');
      expect(result.kind === 'refused' && result.message).toContain('the login did not reach this agent');
      // Both peers ended, even though the second one answered with an error.
      expect(h.opened.length).toBe(2);
      expect(h.closed()).toBe(2);
    });
  });
}
