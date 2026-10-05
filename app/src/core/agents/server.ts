/**
 * A private `opencode serve`, for the one thing ACP cannot carry: the provider login.
 *
 * ACP's `authMethods` for opencode is a single terminal method, so a window cannot finish a login over the
 * channel it already has. opencode v2 has the other half as an HTTP API (`core/login/api.ts`); this file
 * starts the server that API lives on, for as long as a login takes.
 *
 * **Why it is safe to have a server at all.** It binds `127.0.0.1` on a port the OS picks (`--port 0`, so
 * nothing fixed to find or squat on), and every request needs a Basic-auth password that exists only in
 * this process and the child's environment — generated per start, never written anywhere, never logged.
 * It lives under the same isolation environment as the agent it belongs to (`isolation.ts`), which is the
 * point: the login has to land in the store *that* agent reads. And it is closed as soon as the login is.
 *
 * **Only a copy that runs where kurier runs.** A bundled agent runs inside the sandbox, so its loopback is
 * ours. A *host* opencode under a Flatpak runs on the other side of `flatpak-spawn --host`, in a network
 * the sandbox cannot see, so there is nothing to connect to: `whyNoLoginServer` says so and the caller
 * falls back to `kurier auth`.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { HttpResponse, Send } from '../login/api.ts';

import { prepareIsolation } from './isolation.ts';
import { isSandboxed, type SandboxFacts } from './sandbox.ts';
import type { AgentCommand } from './stdio.ts';

export const SERVER_START_TIMEOUT_MS = 20_000;

/** How long a stopping server gets before SIGKILL. */
export const SERVER_KILL_GRACE_MS = 2_000;

/** The line `opencode serve` prints once it listens (measured: `server listening on http://127.0.0.1:38775`). */
const LISTENING = /server listening on (http:\/\/\S+)/;

export interface OpencodeServer {
  readonly baseUrl: string;
  /** In memory only; exposed so a test can see it reached the child's environment. */
  readonly password: string;
  readonly send: Send;
  /** Stop the server and wait until it is gone. Safe to call twice. */
  close(): Promise<void>;
}

/** The command for the server, from the command for the agent: same program, same environment. */
export function serverCommand(agent: AgentCommand): AgentCommand {
  return { ...agent, args: ['serve', '--port', '0'] };
}

/** Why a login server cannot be reached from here, or `null` when it can. */
export function whyNoLoginServer(agent: AgentCommand, facts: SandboxFacts): string | null {
  if (!agent.bundled && isSandboxed(facts)) {
    return (
      'your own opencode runs outside this sandbox, so its login server cannot be reached — ' +
      'log in with `kurier auth` in a terminal instead'
    );
  }
  return null;
}

function makeSend(baseUrl: string, password: string): Send {
  const authorization = `Basic ${btoa(`opencode:${password}`)}`;
  return async (method, path, body): Promise<HttpResponse> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = { message: raw.slice(0, 200) };
      }
    }
    return { status: response.status, json };
  };
}

/** Start the server and resolve once it has said where it listens. */
export function startServer(
  command: AgentCommand,
  options: { timeoutMs?: number } = {},
): Promise<OpencodeServer> {
  const password = randomBytes(24).toString('hex');
  const launch = serverCommand(command);
  // A bundled copy's directories have to exist before it writes into them, same as for the agent.
  if (command.bundled) prepareIsolation(command.env);

  return new Promise((resolve, reject) => {
    const child = spawn(launch.program, launch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      env: { ...process.env, ...launch.env, OPENCODE_SERVER_PASSWORD: password },
    });

    let settled = false;
    let exited = false;
    let buffer = '';
    const exit = new Promise<void>((done) => {
      child.once('exit', () => {
        exited = true;
        done();
      });
    });
    const timer = setTimeout(
      () =>
        fail(new Error(`${launch.title} did not report a port within ${SERVER_START_TIMEOUT_MS / 1000}s`)),
      options.timeoutMs ?? SERVER_START_TIMEOUT_MS,
    );

    const close = async (): Promise<void> => {
      if (!exited) child.kill('SIGTERM');
      // A server that ignores SIGTERM must not hang the dialog's close or outlive it.
      const grace = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, SERVER_KILL_GRACE_MS);
      try {
        await exit;
      } finally {
        clearTimeout(grace);
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void close();
      reject(error);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      const found = LISTENING.exec(buffer);
      if (!found) return;
      settled = true;
      clearTimeout(timer);
      const baseUrl = found[1]!.replace(/\/$/, '');
      resolve({ baseUrl, password, send: makeSend(baseUrl, password), close });
    });
    // Nothing is read off stderr: it is the agent's log, and kurier has no use for it here.
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => fail(error));
    child.once('exit', (code, signal) => {
      fail(
        new Error(`${launch.title} stopped before it listened (${signal ?? `exit code ${code ?? 'none'}`})`),
      );
    });
  });
}
