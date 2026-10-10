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
