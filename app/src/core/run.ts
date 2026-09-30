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

/** Re-thrown with the `kurier auth` hint attached, so a caller does not have to know the code. */
export async function withAuthHint<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAuthRequired(error)) {
      throw new Error(
        `${what} failed: the agent wants a human to log in first. Run \`kurier auth\`, then try again.`,
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
  /** Send `session/cancel` as soon as this fires. Used by Ctrl-C. */
  onInterrupt?: () => void;
}

/**
 * One prompt turn, with the `session/update` stream wired up.
 *
 * `session/prompt` is the one request with no timeout: a turn legitimately runs for minutes while
 * the model thinks, and a timeout here would cancel work that was going to finish.
 */
export async function runTurn(client: AcpClient, options: TurnOptions): Promise<{ stopReason: StopReason }> {
  const unsubscribe = client.onSessionUpdate(options.onUpdate);
  const interrupt = options.onInterrupt;
  if (interrupt) {
    process.once('SIGINT', interrupt);
  }
  try {
    const response = await client.prompt({
      sessionId: options.sessionId,
      prompt: [{ type: 'text', text: options.text }],
    });
    return { stopReason: response.stopReason };
  } finally {
    unsubscribe();
    if (interrupt) process.off('SIGINT', interrupt);
  }
}
