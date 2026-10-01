/**
 * The session runner: the three steps every command that talks to an agent performs.
 *
 * Start the process, shake hands, get out of the way. Everything protocol-shaped lives in
 * `@kurier/acp`; everything decision-shaped lives in the `ClientGate` the caller passes in. What
 * is left here is the part that is *only* true of kurier: which launcher, which working
 * directory, and what to do when the agent says it needs a login.
 *
 * The `finally` blocks are the reason this file exists as a unit. An ACP agent is a child process
 * with a model behind it; leaking one means a leaked process and a leaked session, and the second
 * `kurier start` then fails for a reason nobody can reconstruct.
 */

import {
  AcpClient,
  isAuthRequired,
  type ClientGate,
  type SessionNotification,
  type StopReason,
} from '@kurier/acp';
import { classifyAuthMethods } from '@kurier/acp/gate';

import { stdioTransport, type AgentCommand } from './agents/stdio.ts';
import { AUTH_COMMAND, AuthRequiredError } from './failure.ts';

export interface AgentHandle {
  client: AcpClient;
  /** Stderr from the agent, already split into lines. */
  readonly logLines: string[];
  /** Name and version the agent reported, for `kurier start`'s first line. */
  readonly agentInfo: string;
  close(): void;
}

export interface OpenAgentOptions {
  command: AgentCommand;
  gate: ClientGate;
  /** Where the agent's stderr goes. A person watching a turn wants to see it. */
  onLog?: (line: string) => void;
  /** Printed once, before the handshake. */
  onNotice?: (message: string) => void;
  /**
   * Called the moment the child process exists and the connection can be closed — **before** the
   * handshake, not after it.
   *
   * The gap this closes is a real orphan, not a theoretical one: a cold `opencode acp` takes
   * seconds to answer `initialize`, and a Ctrl-C inside that window used to kill kurier with no
   * handler installed and the agent still running. Handing the caller a closer at spawn time means
   * there is no interval in which a process exists that nobody can end. See `interrupt.ts`.
   */
  onSpawn?: (close: () => void) => void;
}

/**
 * Start an agent and complete the handshake.
 *
 * The handshake is where trap 1 is caught. An agent that advertises an auth method means a session
 * will fail later; the notice is printed *now*, with the command to run, so the failure the user
 * meets is a sentence rather than a stack.
 */
export async function openAgent(options: OpenAgentOptions): Promise<AgentHandle> {
  const logLines: string[] = [];
  const transport = stdioTransport({
    command: options.command,
    onStderr: (line) => {
      logLines.push(line);
      options.onLog?.(line);
    },
  });
  const client = new AcpClient({ transport, gate: options.gate });
  // Before the handshake on purpose — see the note on `onSpawn`.
  options.onSpawn?.(() => client.close());

  try {
    const result = await client.initialize();
    const auth = classifyAuthMethods(client.authMethods);
    if (!auth.none) {
      options.onNotice?.(describeAuth(auth.agent, auth.terminal));
    }
    const info = result.agentInfo;
    return {
      client,
      logLines,
      agentInfo: info ? `${info.name} ${info.version}` : 'an unnamed agent',
      close: () => client.close(),
    };
  } catch (error) {
    client.close(`handshake failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Re-thrown with the `kurier auth` hint attached, so a caller does not have to know the code.
 *
 * **`AuthRequiredError` and not a plain `Error`, and the message alone is why.** The hint turns
 * ACP's `-32000` into a sentence a person can act on, and a sentence is not a classification: a
 * surface that can only see the text cannot tell "run this in a terminal" from "the binary is not on
 * PATH", so plan §6's auth dialog would have to be guessed at from wording. The class carries the kind
 * across the hint, and `failureKind` reads it — see `core/failure.ts`. The message still leads with
 * the command, so the CLI and the log read the same as before.
 */
export async function withAuthHint<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAuthRequired(error)) {
      throw new AuthRequiredError(
        `${what} failed: the agent wants a human to log in first. Run \`${AUTH_COMMAND}\`, then try again.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function describeAuth(
  agent: { id: string; name: string; description?: string }[],
  terminal: { id: string; name: string }[],
): string {
  const lines = ['this agent advertises authentication:'];
  for (const method of terminal) lines.push(`  ${method.name} (${method.id}) — the agent can run it itself`);
  for (const method of agent) {
    const hint = method.description ? ` — ${method.description}` : '';
    lines.push(`  ${method.name} (${method.id})${hint}`);
  }
  lines.push('  `kurier auth` arranges it; a session started before that will fail with -32000.');
  return lines.join('\n');
}

export interface TurnOptions {
  sessionId: string;
  text: string;
  /** Called for every `session/update`, in order, before the turn settles. */
  onUpdate: (notification: SessionNotification) => void;
}

/**
 * One prompt turn, with the `session/update` stream wired up.
 *
 * `session/prompt` is the one request with no timeout: a turn legitimately runs for minutes while
 * the model thinks, and a timeout here would cancel work that was going to finish.
 *
 * **No signal handling here any more.** Ctrl-C belongs to the command, which owns the state that
 * decides what it means — see `interrupt.ts` for the orphan this rearrangement closed.
 */
export async function runTurn(client: AcpClient, options: TurnOptions): Promise<{ stopReason: StopReason }> {
  const unsubscribe = client.onSessionUpdate(options.onUpdate);
  try {
    const response = await client.prompt({
      sessionId: options.sessionId,
      prompt: [{ type: 'text', text: options.text }],
    });
    return { stopReason: response.stopReason };
  } finally {
    unsubscribe();
  }
}
