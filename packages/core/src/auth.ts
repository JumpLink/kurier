/**
 * Trap 1, decided once: what to do about the login an agent advertises, and what to say about it.
 *
 * Measured against `opencode acp` 2.0.19:
 *
 * ```
 * "authMethods":[{"description":"Run `opencode auth login` in the terminal",
 *                 "name":"Login with opencode","id":"opencode-login"}]
 * ```
 *
 * No `type` tag, and a `description` the schema does not define. Read as the protocol's *agent* auth
 * method — the kind where the client is expected to arrange the login itself — the sentence in that
 * description is an instruction to the client. `classifyAuthMethods` (`@kurier/acp/gate`) is the first
 * half of the fix; this file is the second: **two paths, and both are real.**
 *
 * - **The agent can run the login itself** (`kind: 'terminal'`, or it handed over `args`). It gets
 *   `authenticate` with its own method id and does the rest in a terminal it already owns. That is the
 *   protocol's designed path and it is preferred.
 * - **Nobody but the client can.** kurier runs the adapter's own login command, and whatever that
 *   wants to open — a browser, a device code, a terminal menu — has to reach the person sitting there.
 *   Then the agent is asked again, so the answer is the agent's own rather than kurier's assumption.
 *
 * **Why this is core and not the CLI.** The decision used to live in `frontends/cli/auth.ts` and the
 * notice in a private function in `run.ts`, which made the window either re-derive both or send a person
 * to a terminal. One implementation, three consumers: `authPlan` is the choice, `describeAuthMethods`
 * is the sentence, `loginCommandFor` is the program, and `arrangeAuth` walks the sequence. What stays
 * with the surface is the only part that genuinely differs — *how* an interactive login is run — which
 * arrives as `runLogin`. The CLI inherits its stdio; a window has to do something else entirely.
 *
 * Either way the login is a **person**, it is never forwarded over the ACP channel, and it is never
 * stored: there is nowhere in kurier that could keep a credential, which is the honest reason rather
 * than a missing feature.
 */

import type { AuthMethodInfo, ClassifiedAuthMethods, ClientGate } from '@kurier/acp';
import { classifyAuthMethods } from '@kurier/acp/gate';

import { DEFAULT_AGENT } from './agents/launcher.ts';
import { OPENCODE_LOGIN } from './agents/opencode.ts';
import { which, type AgentCommand } from './agents/stdio.ts';
import { AUTH_COMMAND } from './failure.ts';
import { openAgent, type AgentHandle, type OpenAgentOptions } from './run.ts';

/**
 * What an agent's `authMethods` mean for a client, as one value.
 *
 * `agent` is the method id for a login kurier has to arrange, `terminal` the one the agent can run
 * itself; `methods` is everything it advertised, in the order the notice reads them. `unusable` is an
 * agent that advertised authentication but no id kurier can name — not nothing, so it may not be
 * treated as `none`.
 */
export type AuthPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'agent-runs-it'; readonly methodId: string; readonly methods: readonly AuthMethodInfo[] }
  | {
      readonly kind: 'client-arranges-it';
      readonly methodId: string;
      readonly methods: readonly AuthMethodInfo[];
    }
  | { readonly kind: 'unusable'; readonly methods: readonly AuthMethodInfo[] };

/** The plan for what an agent advertised. Pure, so both surfaces and a test read the same decision. */
export function authPlan(methods: AuthMethodInfo[] | undefined): AuthPlan {
  const auth = classifyAuthMethods(methods);
  if (auth.none) return { kind: 'none' };
  const all = [...auth.terminal, ...auth.agent];
  const terminal = auth.terminal[0]?.id;
  if (terminal) return { kind: 'agent-runs-it', methodId: terminal, methods: all };
  const agent = auth.agent[0]?.id;
  if (agent) return { kind: 'client-arranges-it', methodId: agent, methods: all };
  return { kind: 'unusable', methods: all };
}

/**
 * The notice a surface shows when a handshake meets an agent that wants a login: what it advertised,
 * which of it the agent can do itself, and the one command that arranges the rest.
 *
 * Printed at handshake time rather than at the failure, because `-32000` arrives in the middle of a
 * turn and a stack trace is not an instruction.
 */
export function describeAuthMethods(auth: ClassifiedAuthMethods): string {
  const lines = ['this agent advertises authentication:'];
  for (const method of auth.terminal) {
    lines.push(`  ${method.name} (${method.id}) — the agent can run it itself`);
  }
  for (const method of auth.agent) {
    lines.push(`  ${method.name} (${method.id})${method.description ? ` — ${method.description}` : ''}`);
  }
  lines.push(`  \`${AUTH_COMMAND}\` arranges it; a session started before that will fail with -32000.`);
  return lines.join('\n');
}

/** One advertised method as a surface lists it: `name (id) — description`. */
export function describeAuthMethod(method: AuthMethodInfo): string {
  return `${method.name} (${method.id})${method.description ? ` — ${method.description}` : ''}`;
}

/**
 * The login command per adapter. A program to run, not a permission to hold.
 *
 * For the bundled copy it is the copy's own program with its own environment: a login run through the
 * person's `opencode` would land in their config, and the bundled agent would never see it.
 */
export function loginCommandFor(agent: AgentCommand): AgentCommand {
  if (agent.id !== DEFAULT_AGENT) {
    throw new Error(`no login command is known for agent "${agent.id}" — run the agent's own login`);
  }
  return agent.bundled
    ? { ...agent, args: OPENCODE_LOGIN.args }
    : {
        id: OPENCODE_LOGIN.id,
        title: OPENCODE_LOGIN.title,
        program: OPENCODE_LOGIN.program,
        args: OPENCODE_LOGIN.args,
      };
}

export interface AuthHooks {
  /** The agent the login is for. */
  readonly command: AgentCommand;
  /** Answers whatever the agent asks during the two short handshakes. */
  readonly gate: ClientGate;
  /**
   * Run the login command where a person can finish it, and resolve with its exit code. The one part
   * that cannot be shared: the CLI inherits its stdio, a window cannot.
   */
  readonly runLogin: (command: AgentCommand) => Promise<number>;
  /** `which`, injected so a plan can be tested without a PATH. Defaults to the real one. */
  readonly lookup?: (program: string) => string | null;
  /**
   * Start an agent and hand back a handshaken handle. Defaults to `openAgent`, and is injected for the
   * same reason `Transport` is: the order of the two handshakes is the whole decision here, and a test
   * that had to spawn an agent to read that order would not be run.
   */
  readonly open?: (options: OpenAgentOptions) => Promise<AgentHandle>;
  /** Stderr from the agent, line by line. */
  readonly onLog?: (line: string) => void;
  /** Every method the agent advertised, in the order a surface lists them. */
  readonly onMethod?: (method: AuthMethodInfo) => void;
  /** What is about to happen, once per step — the surface decides how a step is set apart. */
  readonly onStep?: (message: string) => void;
}

/**
 * How it ended, as one value the surface renders. Every arm names what a person can do next, and
 * nothing here writes to a stream — a window and a terminal word the same outcome differently.
 */
export type AuthArrangement =
  | { readonly kind: 'none' }
  | { readonly kind: 'authenticated'; readonly methodId: string; readonly viaLogin: boolean }
  | { readonly kind: 'unusable' }
  | { readonly kind: 'login-missing'; readonly command: AgentCommand }
  | { readonly kind: 'login-failed'; readonly command: AgentCommand; readonly code: number }
  | { readonly kind: 'refused'; readonly methodId: string; readonly message: string };

/**
 * Arrange the login an agent asked for: ask it first, run the command second, ask it again.
 *
 * Two handshakes, not one, and the second is the point: the agent is asked whether the login took,
 * instead of kurier assuming a zero exit code meant yes. Both are closed in a `finally` — an ACP agent
 * is a child process with a model behind it, and a leaked one is a leaked session too.
 */
export async function arrangeAuth(hooks: AuthHooks): Promise<AuthArrangement> {
  const lookup = hooks.lookup ?? which;
  const open = hooks.open ?? openAgent;
  const first = await open({ command: hooks.command, gate: hooks.gate, onLog: hooks.onLog });
  let plan: AuthPlan;
  try {
    plan = authPlan(first.client.authMethods);
    if (plan.kind === 'none') return { kind: 'none' };
    for (const method of plan.methods) hooks.onMethod?.(method);
    if (plan.kind === 'unusable') return { kind: 'unusable' };
    if (plan.kind === 'agent-runs-it') {
      hooks.onStep?.(`asking ${hooks.command.title} to authenticate itself…`);
      await first.client.authenticate({ methodId: plan.methodId });
      return { kind: 'authenticated', methodId: plan.methodId, viaLogin: false };
    }
  } finally {
    first.close();
  }

  const login = loginCommandFor(hooks.command);
  if (!lookup(login.program)) return { kind: 'login-missing', command: login };
  hooks.onStep?.(`running \`${login.program} ${login.args.join(' ')}\` — a person has to finish this one:`);
  const code = await hooks.runLogin(login);
  if (code !== 0) return { kind: 'login-failed', command: login, code };

  const second = await open({ command: hooks.command, gate: hooks.gate, onLog: hooks.onLog });
  try {
    await second.client.authenticate({ methodId: plan.methodId });
    return { kind: 'authenticated', methodId: plan.methodId, viaLogin: true };
  } catch (error) {
    return {
      kind: 'refused',
      methodId: plan.methodId,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    second.close();
  }
}
