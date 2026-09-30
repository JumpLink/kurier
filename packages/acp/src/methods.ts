/**
 * The method table — the one place in kurier where an ACP method name is spelled out.
 *
 * Everything else imports from here, and `scripts/check-schema.mjs` compares this table against
 * `refs/acp/schema.v1.json` on every `npm run check:schema`. A renamed upstream method, a new
 * capability and a typo therefore all fail the same way: a build that says which name it wanted.
 *
 * The names are NOT free-form strings scattered through the client. That is the whole reason this
 * file exists: a typo in a `method:` field is a runtime "method not found" against a live agent,
 * which is the most expensive kind of bug to find.
 */

/** Methods the client sends to the agent (schema side: `agent`). */
export const CLIENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  logout: 'logout',
  newSession: 'session/new',
  loadSession: 'session/load',
  resumeSession: 'session/resume',
  listSessions: 'session/list',
  closeSession: 'session/close',
  deleteSession: 'session/delete',
  setSessionMode: 'session/set_mode',
  setSessionConfigOption: 'session/set_config_option',
  prompt: 'session/prompt',
} as const;

/** Notifications the client sends to the agent — no response, so no id. */
export const CLIENT_NOTIFICATIONS = {
  /** Cancels the in-flight prompt turn. The agent must answer the turn with `cancelled`. */
  cancel: 'session/cancel',
} as const;

/** Methods the agent sends to the client (schema side: `client`). */
export const AGENT_METHODS = {
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
  requestPermission: 'session/request_permission',
  createElicitation: 'elicitation/create',
} as const;

/**
 * Methods the agent may send that kurier does **not** answer.
 *
 * Listed so the schema check can see them and so their absence is a decision on the record rather
 * than an omission. `terminal/*` is the whole group: `AcpClient` announces
 * `clientCapabilities.terminal: false`, so an agent has no reason to send one, and if it does the
 * generic "method not found" answer in `AcpClient.#onAgentRequest` is the correct one — a client
 * that has no shell must not grow a shell because an agent asked.
 */
export const UNSUPPORTED_AGENT_METHODS = {
  createTerminal: 'terminal/create',
  terminalOutput: 'terminal/output',
  releaseTerminal: 'terminal/release',
  waitForTerminalExit: 'terminal/wait_for_exit',
  killTerminal: 'terminal/kill',
} as const;

/** Notifications the agent sends to the client. */
export const AGENT_NOTIFICATIONS = {
  sessionUpdate: 'session/update',
  elicitationComplete: 'elicitation/complete',
} as const;

export type ClientMethod = (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];
export type AgentMethod = (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS];
