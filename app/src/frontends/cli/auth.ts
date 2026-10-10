/**
 * `lotse auth` — trap 1 of the plan, given a command.
 *
 * Without this command `lotse start` dies on `-32000 auth_required` with a stack trace instead of a
 * sentence. What it does about that is decided in `@lotse/core`'s `auth.ts`: which of the two paths an
 * agent's `authMethods` allow, what the login command is, and the order the two handshakes run in. What
 * is here is the terminal: the flags, the lines, the exit codes, and the one thing a window would have
 * to do differently — running the login with **inherited stdio**, because a login that opens a browser
 * cannot open one from a process whose stdio is a pipe.
 */

import { spawn } from 'node:child_process';

import type { CommandModule } from 'yargs';

import {
  arrangeAuth,
  currentSandboxFacts,
  describeAuthMethod,
  toHostCommand,
  which,
  type AgentCommand,
  type LotsePaths,
} from '@lotse/core';

import { agentForNew } from './choose.ts';
import { silentGate } from './gate.ts';
import { err, out, pickArgv } from './output.ts';

const command = (paths: LotsePaths): CommandModule => ({
  command: 'auth',
  describe: 'arrange the login an agent asked for, so a session does not die on -32000',
  builder: (yargs) =>
    yargs
      .option('agent', {
        type: 'string',
        describe: 'which agent to log in (default: your own install, else the bundled copy)',
      })
      .option('quiet', { type: 'boolean', describe: "do not echo the agent's log lines" })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const quiet = pickArgv<boolean>(raw, 'quiet') === true;
    const resolved = agentForNew(paths, pickArgv<string>(raw, 'agent'));
    if (!resolved) return;
    const launcher = resolved.command;
    if (resolved.isolation) {
      err(`  a login here is kept in ${resolved.isolation.data} and is not your own opencode login`);
    }
    if (!which(launcher.program)) {
      err(`${launcher.program} is not on PATH — install it, or point PATH at it, then try again`);
      process.exitCode = 1;
      return;
    }

    const result = await arrangeAuth({
      command: launcher,
      gate: silentGate(),
      runLogin: runInteractively,
      onLog: (line) => {
        if (!quiet) err(`  [agent] ${line}`);
      },
      onMethod: (method) => err(`  ${describeAuthMethod(method)}`),
      onStep: (message) => err(`\n${message}`),
    });

    switch (result.kind) {
      case 'none':
        out(`${launcher.title} needs no authentication.`);
        return;
      case 'authenticated':
        out(
          result.viaLogin
            ? `logged in — ${launcher.title} accepted "${result.methodId}"`
            : `logged in — ${launcher.title} authenticated with "${result.methodId}"`,
        );
        return;
      case 'unusable':
        err('the agent advertised an auth method without an id — nothing kurier can do with it');
        process.exitCode = 1;
        return;
      case 'login-missing':
        err(
          `${result.command.program} is not on PATH — run \`${result.command.program} ${result.command.args.join(' ')}\` yourself`,
        );
        process.exitCode = 1;
        return;
      case 'login-failed':
        err(`login command exited with ${result.code} — not authenticated`);
        process.exitCode = result.code;
        return;
      case 'refused':
        err(`the agent did not accept the login: ${result.message}`);
        process.exitCode = 1;
        return;
    }
  },
});

/**
 * Run a command with stdio inherited from this process, and resolve with its exit code.
 *
 * Routed through the same host rewrite as the ACP channel (`agents/sandbox.ts`), because a login is a
 * host program for exactly the reason the agent is: it opens a browser and keeps its credentials under
 * the person's own home. A `lotse auth` that only worked on a desktop install would be a second
 * version of the same bug.
 */
function runInteractively(command: AgentCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    // `cwd`/`env` are read off the rewritten command for the same reason as in StdioChannel: on a
    // Flatpak they are the host's, carried in the argv, and re-applying them to `flatpak-spawn` would
    // place it in a directory that does not exist in the sandbox.
    const actual = toHostCommand(command, currentSandboxFacts());
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
