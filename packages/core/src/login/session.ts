/**
 * The real `LoginSession`: a private `opencode serve` and the login API over it.
 *
 * The only place a window's login dialog meets a process. `LoginController` is handed `openSession` and
 * `unavailableReason` from here, so it never imports the server and its tests never start one.
 */

import { startServer, whyNoLoginServer } from '../agents/server.ts';
import { currentSandboxFacts } from '../agents/sandbox.ts';
import { which } from '../agents/stdio.ts';
import type { AgentCommand } from '../agents/stdio.ts';

import { createLoginApi } from './api.ts';
import type { LoginSession } from './controller.ts';
import { connectionFacts, type ConnectionFacts } from '../onboarding.ts';

/** Only opencode has the HTTP login API kurier drives; another adapter keeps the terminal hint. */
export function loginUnavailableReason(agent: AgentCommand): string | null {
  if (agent.id !== 'opencode') return `${agent.title} has no login kurier can run — use its own login`;
  const reason = whyNoLoginServer(agent, currentSandboxFacts());
  if (reason) return reason;
  if (!which(agent.program)) return `${agent.program} is not on PATH — install it, then try again`;
  return null;
}

export async function openLoginSession(agent: AgentCommand): Promise<LoginSession> {
  const server = await startServer(agent);
  const api = createLoginApi(server.send);
  return {
    providers: () => api.providers(),
    connectKey: (providerId, key, answer) => api.connectKey(providerId, key, answer),
    begin: (providerId, methodId, answer) => api.begin(providerId, methodId, answer),
    status: (providerId, attemptId) => api.status(providerId, attemptId),
    complete: (providerId, attemptId, code) => api.complete(providerId, attemptId, code),
    cancel: (providerId, attemptId) => api.cancel(providerId, attemptId),
    close: () => server.close(),
  };
}

/** How long the probe may take in all before the ordinary chat is shown and the server is closed. */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeDeps {
  readonly reason?: (agent: AgentCommand) => string | null;
  readonly open?: (agent: AgentCommand) => Promise<LoginSession>;
  readonly timeoutMs?: number;
  /** Aborted by a host that is shutting down: the probe answers `unknown` and closes its server. */
  readonly signal?: AbortSignal;
}

/**
 * Which providers the agent has connected, asked of a private login server that is closed again at once.
 * Any failure, a timeout or an abort is `unknown`: the caller then shows the ordinary chat and a failing
 * turn still offers the login. The server is closed on every path, including a late start.
 */
export async function probeConnections(agent: AgentCommand, deps: ProbeDeps = {}): Promise<ConnectionFacts> {
  const unknown: ConnectionFacts = { kind: 'unknown' };
  if ((deps.reason ?? loginUnavailableReason)(agent) !== null || deps.signal?.aborted) return unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<ConnectionFacts>((resolve) => {
    timer = setTimeout(() => resolve(unknown), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    onAbort = () => resolve(unknown);
    deps.signal?.addEventListener('abort', onAbort);
  });
  const opening = Promise.resolve().then(() => (deps.open ?? openLoginSession)(agent));
  const read = opening.then(
    async (session) => connectionFacts(await session.providers()),
    () => unknown,
  );
  try {
    return await Promise.race([read.catch(() => unknown), giveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort) deps.signal?.removeEventListener('abort', onAbort);
    const session = await opening.catch(() => undefined);
    await session?.close().catch(() => undefined);
  }
}
