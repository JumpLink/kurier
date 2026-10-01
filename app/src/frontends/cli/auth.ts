/**
 * `kurier auth` — trap 1 of the plan, given a command.
 *
 * Measured against `opencode acp` 2.0.19:
 *
 * ```
 * "authMethods":[{"description":"Run `opencode auth login` in the terminal",
 *                 "name":"Login with opencode","id":"opencode-login"}]
 * ```
 *
 * Note the shape: no `type` tag, and a `description` the schema does not define. Read as the
 * protocol's *agent* auth method — the kind where the client is expected to arrange the login
 * itself — the sentence in that description is an instruction to the client. Without this command,
 * `kurier start` dies on `-32000 auth_required` with a stack trace instead of a sentence.
 *
 * Two paths, and both are real:
 *
 * - **The agent can run the login itself** (`kind: 'terminal'`, or it handed over `args`). The
 *   agent gets `authenticate` with its own method id, and it does the rest in a terminal it
 *   already owns. That is the protocol's designed path and it is preferred.
 * - **Nobody but the client can.** `kurier` runs the adapter's login command as a child process
 *   with inherited stdio, so whatever the login wants to open — a browser, a device code, a
 *   terminal menu — reaches the person sitting there. Then the agent is asked again.
 *
 * Either way the login is a **person at a terminal**. It is never forwarded over the ACP channel
 * and never stored: there is nowhere in Scheibe 1 that could keep a credential, which is the
 * honest reason rather than a missing feature.
 */

import { spawn } from 'node:child_process';

import type { CommandModule } from 'yargs';

import { classifyAuthMethods } from '@kurier/acp/gate';

import { DEFAULT_AGENT, requireLauncher } from '../../core/agents/launcher.ts';
import { OPENCODE_LOGIN } from '../../core/agents/opencode.ts';
import { currentSandboxFacts, toHostCommand } from '../../core/agents/sandbox.ts';
import { which } from '../../core/agents/stdio.ts';
import { openAgent } from '../../core/run.ts';

import { silentGate } from './gate.ts';
import { err, out, pickArgv } from './output.ts';

/** The login command per adapter. A program to run, not a permission to hold. */
function loginCommandFor(agentId: string): { program: string; args: string[] } {
  if (agentId === DEFAULT_AGENT) return { program: OPENCODE_LOGIN.program, args: OPENCODE_LOGIN.args };
  throw new Error(`no login command is known for agent "${agentId}" — run the agent's own login`);
}

const command: CommandModule = {
  command: 'auth',
  describe: 'arrange the login an agent asked for, so a session does not die on -32000',
  builder: (yargs) =>
    yargs
      .option('agent', { type: 'string', default: DEFAULT_AGENT, describe: 'which agent to log in' })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const agentId = pickArgv<string>(raw, 'agent') ?? DEFAULT_AGENT;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    const launcher = requireLauncher(agentId);
    if (!which(launcher.program)) {
      err(`${launcher.program} is not on PATH — install it, or point PATH at it, then try again`);
      process.exitCode = 1;
      return;
    }

    // First, ask: maybe the agent can do this itself, which is the protocol's own path.
    const first = await openAgent({
      command: launcher,
      gate: silentGate(),
      onLog: (line) => {
        if (!quiet) err(`  [agent] ${line}`);
      },
    });
    let terminalMethodId: string | null = null;
    let agentMethodId: string | null = null;
    try {
      const auth = classifyAuthMethods(first.client.authMethods);
      if (auth.none) {
        out(`${launcher.title} needs no authentication.`);
        return;
      }
      terminalMethodId = auth.terminal[0]?.id ?? null;
      agentMethodId = auth.agent[0]?.id ?? null;
      for (const method of [...auth.terminal, ...auth.agent]) {
        const description = (method as { description?: string }).description;
        err(`  ${method.name} (${method.id})${description ? ` — ${description}` : ''}`);
      }
      if (terminalMethodId) {
        err(`\nasking ${launcher.title} to authenticate itself…`);
        await first.client.authenticate({ methodId: terminalMethodId });
        out(`logged in — ${launcher.title} authenticated with "${terminalMethodId}"`);
        return;
      }
    } finally {
      first.close();
    }

    // Second path: the client arranges it. The child inherits stdio, because a login that opens a
    // browser cannot open one from a process whose stdio is a pipe.
    if (!agentMethodId) {
      err('the agent advertised an auth method without an id — nothing kurier can do with it');
      process.exitCode = 1;
      return;
    }
    const login = loginCommandFor(agentId);
    const found = which(login.program);
    if (!found) {
      err(`${login.program} is not on PATH — run \`${login.program} ${login.args.join(' ')}\` yourself`);
      process.exitCode = 1;
      return;
    }
    err(`\nrunning \`${login.program} ${login.args.join(' ')}\` — a person has to finish this one:`);
    const code = await runInteractively(login);
    if (code !== 0) {
      err(`login command exited with ${code} — not authenticated`);
      process.exitCode = code;
      return;
    }

    // Ask the agent again, so the answer is the agent's own rather than kurier's assumption.
    const second = await openAgent({
      command: launcher,
      gate: silentGate(),
      onLog: (line) => {
        if (!quiet) err(`  [agent] ${line}`);
      },
    });
    try {
      await second.client.authenticate({ methodId: agentMethodId });
      out(`logged in — ${launcher.title} accepted "${agentMethodId}"`);
    } catch (error) {
      err(`the agent did not accept the login: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      second.close();
    }
  },
};

/**
 * Run a command with stdio inherited from this process, and resolve with its exit code.
 *
 * Routed through the same host rewrite as the ACP channel (`sandbox.ts`), because a login is a host
 * program for exactly the reason the agent is: it opens a browser and keeps its credentials under
 * the person's own home. A `kurier auth` that only worked on a desktop install would be a second
 * version of the same bug.
 */
function runInteractively(command: { program: string; args: string[] }): Promise<number> {
  return new Promise((resolve, reject) => {
    // `cwd`/`env` are read off the rewritten command for the same reason as in StdioChannel: on a
    // Flatpak they are the host's, carried in the argv, and re-applying them to `flatpak-spawn` would
    // place it in a directory that does not exist in the sandbox.
    const actual = toHostCommand(
      { id: 'interactive', title: command.program, program: command.program, args: command.args },
      currentSandboxFacts(),
    );
    const child = spawn(actual.program, actual.args, {
      stdio: 'inherit',
      ...(actual.cwd ? { cwd: actual.cwd } : {}),
      ...(actual.env ? { env: { ...process.env, ...actual.env } } : {}),
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export const authCommand = command;
