/**
 * The client half of ACP: what kurier is willing to do when the agent asks, and what it
 * advertises up front.
 *
 * This file is where the plan's guardrails (§5) become code rather than intentions. Three of them
 * live here and are load-bearing:
 *
 * - **`fs/read_text_file` and `fs/write_text_file` are answered `false`** — in the capability
 *   announcement, so the agent is told up front. File access is a decision, never a default.
 * - **`session/request_permission` fails closed.** `denyAll` is the default gate, and the type
 *   system is arranged so that replacing it requires naming a `PermissionGate` — a human or a
 *   policy that answers. There is no "allow because the agent asked" path in this file, and
 *   `kurier` adds none.
 * - **A session is a scope, not a permission.** Nothing here is stored with a session: there is
 *   no allow-list to persist, therefore none to hand on. `assertScopeIsNotAuthority` is a runtime
 *   canary over the persisted record, so a future field cannot quietly reintroduce the key.
 */

import type {
  AuthMethodInfo,
  ClientCapabilities,
  CreateElicitationRequest,
  Implementation,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
} from './types.ts';

/** What kurier calls itself in `initialize.clientInfo`. */
export const LOTSE_IMPLEMENTATION: Implementation = { name: 'lotse', version: '0.1.1' };

/**
 * The capabilities kurier announces. Both file-system flags are `false` and `terminal` is
 * `false`: the agent gets no channel to kurier's file system and no channel to a shell. A later
 * slice may add one, but it has to be added *here*, visibly, next to the reasoning.
 *
 * `session.configOptions` announces that kurier can **act on** a session's configuration — the
 * model, the thought level, the mode. Two things about it are deliberate:
 *
 * - **It is a client capability.** It sits under `ClientCapabilities.session`, so it is kurier
 *   saying what it can do, not a record of what the agent offered. Measured against
 *   `opencode acp` 2.0.19: the agent answers `session/new` with 400+ models, 6 thought levels and
 *   2 modes whether kurier announces this or not — which is a reason to announce, not a reason to
 *   believe the announcement made the options appear.
 * - **`boolean` is omitted, so it will not be sent.** `{}` there means "I can render a switch";
 *   leaving it out means the agent must not include `type: "boolean"` options. The surface does not
 *   exist yet, and a capability announced before it is implemented is a promise the agent is
 *   entitled to act on. It goes in when the switch goes in — next to this line, not in a later
 *   commit that leaves no trace of why.
 */
export const LOTSE_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  session: { configOptions: {} },
};

/**
 * Answers a `session/request_permission`.
 *
 * The parameter is the request and the answer is an option id **the agent offered** — a gate
 * cannot invent an outcome, and it cannot return a bare "yes" that the agent then maps to
 * whatever `allow_always` meant. Returning `null` is the one thing every gate may do; it means
 * "cancelled", which is how a cancelled prompt turn is answered.
 */
export type PermissionGate = (request: RequestPermissionRequest) => Promise<string | null> | string | null;

/** The default gate. Denies by choosing nothing, so the turn is reported as cancelled. */
export const denyAll: PermissionGate = () => null;

/**
 * Picks a rejecting option out of the ones the agent offered, so the turn ends the way the
 * protocol expects rather than being dropped. Falls back to `null` when the agent offered no
 * rejecting option at all — an agent that offers only `allow_*` must not get an allow out of a
 * gate that declined.
 */
export function rejectOnce(request: RequestPermissionRequest): string | null {
  const rejecting = request.options.find((option) => option.kind.startsWith('reject'));
  return rejecting?.optionId ?? null;
}

export function cancelledOutcome(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

export function selectedOutcome(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } };
}

/**
 * The agent's requests against the client, answered by a `ClientGate`.
 *
 * `readTextFile` and `writeTextFile` are answered unconditionally with an error and are NOT part
 * of the interface. That is deliberate: a gate that could answer them would make "one more
 * capability" a two-line change to a callback, which is exactly the shape of a decision that
 * should be a change to *this file*.
 */
export interface ClientGate {
  /** Fail-closed by default. See `denyAll` and the note on `PermissionGate`. */
  readonly permission: PermissionGate;
  /** Advisory only — kurier never refuses a request because of it. */
  describe?(request: CreateElicitationRequest): Promise<string | null> | string | null;
}

/** A gate that refuses everything. The default for every entry point that does not pass one. */
export const DENY_EVERYTHING: ClientGate = { permission: denyAll };

export function readTextFileRefused(request: ReadTextFileRequest): never {
  throw new FileSystemRefusedError(request.path);
}

export function writeTextFileRefused(request: WriteTextFileRequest): never {
  throw new FileSystemRefusedError(request.path);
}

/**
 * The error kurier returns for a file-system request it does not answer. It is a *refusal*, not
 * a failure: the agent is expected to carry on without that capability, and a good one will.
 */
export class FileSystemRefusedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `lotse does not expose a file system to agents: ${path} was refused on principle, not by accident.`,
    );
    this.name = 'FileSystemRefusedError';
    this.path = path;
  }
}

// ─── authentication: trap 1 of the plan ─────────────────────────────────────────────────────

/**
 * The auth methods an agent advertises, split by what kurier can do about them.
 *
 * `opencode acp` advertises `{ id: "opencode-login", name: "Login with opencode", description:
 * "Run `opencode auth login` in the terminal" }` — no `type`, and a description that is not in
 * the schema. Read as the protocol's *agent* auth method it means "the client is expected to
 * arrange the login itself", which is what `lotse auth` does: it runs the command the agent's
 * own `authenticate` would have run, outside the ACP channel. Dying on a missing
 * `opencode auth login` is trap 1 of the plan, and this classification is the first half of the
 * fix.
 */
export interface ClassifiedAuthMethods {
  /** The agent can run the login itself, in the terminal it already owns. */
  terminal: AuthMethodInfo[];
  /** kurier has to arrange the login, or the session cannot start. */
  agent: AuthMethodInfo[];
  /** Nothing to do. The agent wants no authentication. */
  none: boolean;
}

export function classifyAuthMethods(methods: AuthMethodInfo[] | undefined): ClassifiedAuthMethods {
  const list = methods ?? [];
  const terminal: AuthMethodInfo[] = [];
  const agent: AuthMethodInfo[] = [];
  for (const method of list) {
    if (method.kind === 'terminal' || hasArgs(method)) terminal.push(method);
    else agent.push(method);
  }
  return { terminal, agent, none: list.length === 0 };
}

/**
 * Some agents omit the `type` tag but do hand over a command. `args` is the only shape that lets
 * a client do anything, so its presence is the better signal than a missing tag.
 */
function hasArgs(method: AuthMethodInfo): boolean {
  return Array.isArray(method.args) && method.args.length > 0;
}

// ─── the "scope, not a permission" canary ───────────────────────────────────────────────────

/** The keys that would turn a persisted session into a capability to hand around. */
const AUTHORITY_KEYS = ['allow', 'allowed', 'permissions', 'grants', 'capabilities', 'policy'];

/**
 * Throws when a record that is about to be persisted carries anything that could be read back as
 * a pre-authorization.
 *
 * This is a canary, not a type: TypeScript cannot stop a later `{ ...session, grants: [...] }`
 * from type-checking. What it stops is that shape from being *stored* — and stored is where it
 * starts to travel, through `resume`, through a config file, through a group chat.
 */
export function assertScopeIsNotAuthority(record: Record<string, unknown>): void {
  for (const key of AUTHORITY_KEYS) {
    if (key in record) {
      throw new Error(
        `a kurier session may not carry "${key}": a session says what is reachable, not what is ` +
          'allowed. Grant per call, in the gate — never here.',
      );
    }
  }
}
