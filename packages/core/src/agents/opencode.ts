/**
 * The opencode launcher.
 *
 * One adapter, not two. The plan is explicit: `opencode` exercises the full ACP path with no
 * adapter in between, and the Claude adapter comes later. Two adapters in Scheibe 1 would mean two
 * shapes of the same bug report and half the coverage each.
 *
 * `opencode acp` is a subcommand of the opencode binary, so the "adapter" is one argument. The
 * measured `initialize` answer is in the README and in the tests; what matters here is that nothing
 * in this file interprets it.
 */

import type { AgentCommand } from './stdio.ts';

export const OPENCODE_COMMAND: AgentCommand = {
  id: 'opencode',
  title: 'OpenCode (opencode acp)',
  program: 'opencode',
  args: ['acp'],
};

/**
 * The login command `kurier auth` runs.
 *
 * Trap 1 of the plan: `opencode acp` advertises `{ id: "opencode-login", name: "Login with
 * opencode", description: "Run `opencode auth login` in the terminal" }` — the protocol's *agent*
 * auth method, which means the client is expected to arrange the login itself. Without this,
 * `kurier start` dies on an error message instead of on code.
 *
 * It is a plain command on this machine, not something routed through the ACP channel: the agent
 * asked for a login, and a login is a person at a terminal. Running it as a child process with
 * inherited stdio is what lets the browser it opens work.
 */
export const OPENCODE_LOGIN: AgentCommand = {
  id: 'opencode-login',
  title: 'OpenCode login (opencode auth login)',
  program: 'opencode',
  args: ['auth', 'login'],
};
