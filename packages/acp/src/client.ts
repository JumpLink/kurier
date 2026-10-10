/**
 * `AcpClient` — the connection. Owns the JSON-RPC correlation, the initialize handshake, the
 * session lifecycle, and the answers to the requests an agent is allowed to make of a client.
 *
 * The class is deliberately thin. It knows the protocol and nothing about agents, subprocesses or
 * permissions policy: which agent to talk to is a `Transport` somebody else supplied, and what to
 * answer when the agent asks for permission is a `ClientGate` somebody else passed in. That is the
 * seam `packages/acp/src/transport.ts` describes, and it is why this file is unit-testable on Node
 * with a fixture agent and no subprocess anywhere.
 */

import {
  DENY_EVERYTHING,
  FileSystemRefusedError,
  KURIER_CLIENT_CAPABILITIES,
  KURIER_IMPLEMENTATION,
  cancelledOutcome,
  selectedOutcome,
  type ClientGate,
} from './gate.ts';
import {
  MessageReader,
  ProtocolError,
  RpcError,
  encodeFailure,
  encodeNotification,
  encodeRequest,
  encodeSuccess,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcResponse,
} from './jsonrpc.ts';
import { AGENT_METHODS, AGENT_NOTIFICATIONS, CLIENT_METHODS, CLIENT_NOTIFICATIONS } from './methods.ts';
import { narrowSessionUpdate } from './narrow.ts';
import type { Transport } from './transport.ts';
import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  type AuthenticateRequest,
  type AuthMethodInfo,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestId,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionCapabilities,
  type SessionId,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type WriteTextFileRequest,
} from './types.ts';

/** `session/update` arrives on its own channel: the caller filters by session, not by turn. */
export type SessionUpdateListener = (notification: SessionNotification) => void;

/** Anything on the wire that is not a response to one of our requests. */
export type WireListener = (message: { method: string; params: unknown }) => void;

export interface AcpClientOptions {
  transport: Transport;
  /** Fail-closed unless the caller passes its own. See `DENY_EVERYTHING`. */
  gate?: ClientGate;
  /** How long `initialize` may take. A peer that has not answered by now is broken, not slow. */
  initializeTimeoutMs?: number;
  /** Names this client in `initialize.clientInfo`; overridable so a UI can introduce itself. */
  clientInfo?: Implementation;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

export class AcpClient {
  readonly transport: Transport;
  readonly #gate: ClientGate;
  readonly #reader = new MessageReader();
  readonly #pending = new Map<RequestId, Pending>();
  /**
   * The tail of the permission queue — see `#enqueuePermission`.
   *
   * Always a promise, never rejected, so the chain cannot be broken by one bad answer and leave the
   * requests behind it unanswered forever.
   */
  #permissionQueue: Promise<void> = Promise.resolve();
  readonly #updateListeners = new Set<SessionUpdateListener>();
  readonly #wireListeners = new Set<WireListener>();
  readonly #clientInfo: Implementation;
  readonly #initializeTimeoutMs: number;
  #nextId = 1;
  #closed = false;
  #initializeResult: InitializeResponse | undefined;

  constructor(options: AcpClientOptions) {
    this.transport = options.transport;
    this.#gate = options.gate ?? DENY_EVERYTHING;
    this.#clientInfo = options.clientInfo ?? KURIER_IMPLEMENTATION;
    this.#initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.transport.onMessage((data) => this.#receive(data));
    this.transport.onClose((reason) => this.#failAll(reason));
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────────────────────

  /**
   * The `initialize` handshake, and the only call that must come first.
   *
   * The version is checked, and a mismatch is fatal. ACP says the client should disconnect if it
   * does not support the version the agent answers with, and kurier takes that literally: a v2
   * agent and a v1 client agreeing to muddle along is how a session dies twenty minutes later
   * inside a field that does not exist yet.
   */
  async initialize(request: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    const params: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: KURIER_CLIENT_CAPABILITIES,
      clientInfo: this.#clientInfo,
      ...request,
    };
    const result = (await this.#request(
      CLIENT_METHODS.initialize,
      params,
      this.#initializeTimeoutMs,
    )) as InitializeResponse;
    const negotiated = result?.protocolVersion;
    if (negotiated !== PROTOCOL_VERSION) {
      this.close();
      throw new ProtocolVersionMismatchError(negotiated, PROTOCOL_VERSION, result?.agentInfo);
    }
    this.#initializeResult = result;
    return result;
  }

  /** The `initialize` result, once there has been one. Throws before the handshake. */
  get initialized(): InitializeResponse {
    if (!this.#initializeResult) {
      throw new Error('initialize has not completed on this connection');
    }
    return this.#initializeResult;
  }

  get agentCapabilities() {
    return this.initialized.agentCapabilities ?? {};
  }

  get authMethods(): AuthMethodInfo[] {
    return this.initialized.authMethods ?? [];
  }

  get agentInfo(): Implementation | undefined {
    return this.initialized.agentInfo ?? undefined;
  }

  // ─── capability negotiation: check, do not assume (trap 2) ─────────────────────────────────

  get supportsLoadSession(): boolean {
    return this.agentCapabilities['loadSession'] === true;
  }

  get sessionCapabilities(): SessionCapabilities {
    return this.agentCapabilities['sessionCapabilities'] ?? {};
  }

  /**
   * The v1 spec puts `loadSession` in `agentCapabilities.loadSession` (a boolean) and the rest in
   * `agentCapabilities.sessionCapabilities.*` (marker objects). Two spellings, one question.
   */
  #hasSessionCapability(name: Exclude<keyof SessionCapabilities, '_meta'>): boolean {
    const marker = this.sessionCapabilities[name];
    return marker !== undefined && marker !== null;
  }

  get supportsListSessions(): boolean {
    return this.#hasSessionCapability('list');
  }

  get supportsResumeSession(): boolean {
    return this.#hasSessionCapability('resume');
  }

  get supportsCloseSession(): boolean {
    return this.#hasSessionCapability('close');
  }

  get supportsDeleteSession(): boolean {
    return this.#hasSessionCapability('delete');
  }

  /**
   * How a session that already exists is put back in front of the agent.
   *
   * `session/load` is the default and replays the history; `session/resume` is the fallback for an
   * agent that only offers `resume`, and costs the history. The order is fixed, and asking for the
   * wrong one is a hard error rather than a silent empty session: an agent that cannot `load` says
   * "method not found", which is a fact, while an agent that answers a `resume` it does not
   * support with an empty session is a lie.
   */
  reattach(
    sessionId: SessionId,
    options: { cwd: string; mcpServers?: McpServer[]; additionalDirectories?: string[] },
  ): Promise<LoadSessionResponse | ResumeSessionResponse> {
    if (this.supportsLoadSession) {
      const params: LoadSessionRequest = {
        sessionId,
        cwd: options.cwd,
        mcpServers: options.mcpServers ?? [],
        ...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
      };
      return this.loadSession(params) as Promise<LoadSessionResponse | ResumeSessionResponse>;
    }
    if (this.supportsResumeSession) {
      const params: ResumeSessionRequest = {
        sessionId,
        cwd: options.cwd,
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.additionalDirectories ? { additionalDirectories: options.additionalDirectories } : {}),
      };
      return this.resumeSession(params) as Promise<LoadSessionResponse | ResumeSessionResponse>;
    }
    return Promise.reject(
      new UnsupportedCapabilityError(
        'this agent can neither load nor resume a session, so an existing one cannot be reattached',
        { loadSession: this.supportsLoadSession, resume: this.supportsResumeSession },
      ),
    );
  }

  // ─── authentication ────────────────────────────────────────────────────────────────────────

  async authenticate(params: AuthenticateRequest): Promise<void> {
    await this.#request(CLIENT_METHODS.authenticate, params);
  }

  async logout(): Promise<void> {
    await this.#request(CLIENT_METHODS.logout, {});
  }

  // ─── session lifecycle ─────────────────────────────────────────────────────────────────────

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return (await this.#request(CLIENT_METHODS.newSession, params)) as NewSessionResponse;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return (await this.#request(CLIENT_METHODS.loadSession, params)) as LoadSessionResponse;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return (await this.#request(CLIENT_METHODS.resumeSession, params)) as ResumeSessionResponse;
  }

  /**
   * `session/list`, following `nextCursor` to the end.
   *
   * A real answer paginates — `opencode acp` returns an opaque base64 cursor and more sessions
   * behind it. `kurier sessions` shows the agent's whole history, so it walks the pages; the
   * `maxPages` bound is a stop for a peer that keeps handing back a cursor.
   */
  async listSessions(
    params: Omit<ListSessionsRequest, 'cursor'> = {},
    options: { maxPages?: number } = {},
  ): Promise<ListSessionsResponse> {
    const maxPages = options.maxPages ?? 100;
    const sessions: ListSessionsResponse['sessions'] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const response = (await this.#request(CLIENT_METHODS.listSessions, {
        ...params,
        ...(cursor ? { cursor } : {}),
      })) as ListSessionsResponse;
      sessions.push(...(response.sessions ?? []));
      cursor = response.nextCursor ?? null;
      if (!cursor) return { ...response, sessions };
    }
    return { sessions };
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.supportsCloseSession) {
      throw new UnsupportedCapabilityError('this agent does not support session/close', {
        close: false,
      });
    }
    return (await this.#request(CLIENT_METHODS.closeSession, params)) as CloseSessionResponse;
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    if (!this.supportsDeleteSession) {
      throw new UnsupportedCapabilityError('this agent does not support session/delete', {
        delete: false,
      });
    }
    return (await this.#request(CLIENT_METHODS.deleteSession, params)) as DeleteSessionResponse;
  }

  // ─── session configuration ─────────────────────────────────────────────────────────────────
  //
  // Both of these write a value **inside the agent**, for the lifetime of that session. kurier
  // keeps no copy: the agent's `currentValue` is the truth, and it is re-read on every
  // `session/new`, `session/load` and `config_option_update`. A surface that remembered a preferred
  // model in a kurier file would be holding configuration authority over the agent — the same
  // mistake as "always allow" in different clothes.

  /**
   * `session/set_mode` — switch the session between the modes the agent offered.
   *
   * The v1 response carries no fields: the new mode comes back as a `current_mode_update`
   * notification, which is why the return value is the empty `SetSessionModeResponse` and not a
   * lie about which mode is now active.
   */
  async setMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return (await this.#request(CLIENT_METHODS.setSessionMode, params)) as SetSessionModeResponse;
  }

  /**
   * `session/set_config_option` — pick a model, a thought level, or anything else the agent offers.
   *
   * The answer is the **full** option set, and the caller is expected to use it rather than assume
   * its own value took: an agent that clamps a value it does not have answers with the corrected
   * list, and a surface that kept the guess would show a model that is not in use.
   */
  async setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return (await this.#request(
      CLIENT_METHODS.setSessionConfigOption,
      params,
    )) as SetSessionConfigOptionResponse;
  }

  // ─── prompt turn ───────────────────────────────────────────────────────────────────────────

  /**
   * One prompt turn. The promise settles when the agent stops — the agent streams its output as
   * `session/update` notifications in the meantime, which is why a turn can run for minutes
   * without a timeout here.
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return (await this.#request(CLIENT_METHODS.prompt, params)) as PromptResponse;
  }

  /** Convenience for the common case: one text block, no embedded resources. */
  async ask(sessionId: SessionId, text: string): Promise<PromptResponse> {
    return this.prompt({ sessionId, prompt: [{ type: 'text', text }] });
  }

  /**
   * `session/cancel` — a notification, so nothing comes back. The turn that is running settles on
   * its own with `stopReason: 'cancelled'`.
   */
  cancel(params: CancelNotification): void {
    this.#send(encodeNotification(CLIENT_NOTIFICATIONS.cancel, params));
  }

  // ─── listeners ─────────────────────────────────────────────────────────────────────────────

  /** Subscribe to `session/update`. Returns an unsubscribe function. */
  onSessionUpdate(listener: SessionUpdateListener): () => void {
    this.#updateListeners.add(listener);
    return () => this.#updateListeners.delete(listener);
  }

  /**
   * Subscribe to everything else the agent sends that is not a response — an extension method, an
   * `_meta`-carrying notification, a method from a newer ACP. This is the *passthrough* half of
   * the `_meta` rule: unknown traffic is handed to the caller, never dropped and never fatal.
   */
  onWireMessage(listener: WireListener): () => void {
    this.#wireListeners.add(listener);
    return () => this.#wireListeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Close the connection. Pending requests reject; late agent traffic is ignored, not answered. */
  close(reason = 'kurier closed the connection'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error(reason));
    this.transport.close();
  }

  // ─── the wire ──────────────────────────────────────────────────────────────────────────────

  /**
   * The three ways out onto the wire, and why they differ only in who hears about a failure.
   *
   * **A failed write closes the connection on every path**: a transport that threw once has lost
   * a line, and the next line would arrive at a peer that never saw the one before it. What
   * differs is the caller. `#send` (kurier's own notifications) throws and `#request` rejects,
   * because somebody is waiting on the call and has to learn it never went out. `#write` (answers
   * to the agent) returns quietly, because nobody on kurier's side is waiting for those — the
   * agent asked, and a closed connection is the only answer it can still get. A closed connection
   * is the same split: `#send` throws, `#request` rejects, `#write` drops the line.
   */
  #send(line: string): void {
    if (this.#closed) {
      throw new Error('cannot send on a closed ACP connection');
    }
    try {
      this.transport.write(line);
    } catch (error) {
      this.close(describeWriteFailure(error));
      throw error;
    }
  }

  #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`cannot call ${method} on a closed ACP connection`));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${method} did not answer within ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
      try {
        this.transport.write(encodeRequest(id, method, params));
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
        this.close(describeWriteFailure(error));
      }
    });
  }

  #receive(chunk: string): void {
    if (this.#closed) return;
    let messages;
    try {
      messages = this.#reader.push(chunk);
    } catch (error) {
      // A frame we cannot parse is a broken peer, not a bug to route around: answering it would
      // mean guessing an id. Drop the connection and let every pending request say so.
      this.close(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const message of messages) this.#dispatch(message);
  }

  #dispatch(message: unknown): void {
    if (isResponse(message as never)) {
      this.#settle(message as JsonRpcResponse);
      return;
    }
    if (isNotification(message as never)) {
      this.#onNotification((message as { method: string }).method, (message as { params?: unknown }).params);
      return;
    }
    if (isRequest(message as never)) {
      this.#onAgentRequest(message as { id: RequestId; method: string; params?: unknown });
      return;
    }
    for (const listener of this.#wireListeners) listener({ method: '<unknown>', params: message });
  }

  #settle(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      // A response to a request we already gave up on, or a duplicate. Nothing to do; the peer's
      // answer is not an error and must not reject an unrelated call.
      return;
    }
    this.#pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if ('error' in response) pending.reject(new RpcError(response.error));
    else pending.resolve(response.result);
  }

  #onNotification(method: string, params: unknown): void {
    if (method === AGENT_NOTIFICATIONS.sessionUpdate) {
      // A variant from a newer ACP is not an error and not a drop: it goes to the wire listeners,
      // where a caller can log or forward it. The typed channel only carries what this client
      // implements, which is what lets `KnownSessionUpdate` stay a precise union.
      const update = narrowSessionUpdate((params as { update?: unknown } | null)?.update);
      if (!update) {
        for (const listener of this.#wireListeners) {
          listener({ method, params });
        }
        return;
      }
      const notification = { ...(params as object), update } as SessionNotification;
      for (const listener of this.#updateListeners) {
        try {
          listener(notification);
        } catch (error) {
          // One bad listener must not cost the other listeners their update, and must not take the
          // connection down — a UI that throws while rendering is a UI problem.
          this.#reportError('a session-update listener threw; its update was dropped', error);
        }
      }
      return;
    }
    for (const listener of this.#wireListeners) listener({ method, params });
  }

  #onAgentRequest(request: { id: RequestId; method: string; params?: unknown }): void {
    switch (request.method) {
      case AGENT_METHODS.readTextFile:
        // Answered, not ignored: a JSON-RPC request that gets no response hangs the agent's turn.
        this.#respondRefused(request.id, new FileSystemRefusedError(this.#pathOf(request.params)));
        return;
      case AGENT_METHODS.writeTextFile:
        this.#respondRefused(request.id, new FileSystemRefusedError(this.#pathOf(request.params)));
        return;
      case AGENT_METHODS.requestPermission:
        this.#enqueuePermission(request.id, request.params as RequestPermissionRequest);
        return;
      default:
        // An agent extension we do not know. Method-not-found is the protocol's own answer for
        // exactly this, and it lets the agent carry on without the capability — which is the
        // opposite of crashing, and the whole point of the extensibility rule.
        this.#write(
          encodeFailure(request.id, {
            code: ERROR_CODES.METHOD_NOT_FOUND,
            message: `kurier implements no method "${request.method}"`,
          }),
        );
    }
  }

  /**
   * Put a permission request on a queue so the gate only ever sees **one at a time**.
   *
   * This is not politeness to the gate, it is a contract the gate needs to be safe. A gate is a
   * decision, and a decision has to be made by one person (or one policy) about one thing. An agent
   * doing parallel tool calls can send two `session/request_permission` requests before it has an
   * answer to the first; a terminal gate happens to survive that because a person reads lines in
   * order, but a modal dialog cannot — it has one window, and the second question either vanishes
   * behind the first or overwrites it. Serialising here means every gate kurier ever grows,
   * including the GTK one, can be written as "answer this, then that", with no queue of its own.
   *
   * The order is arrival order. Reversing it would answer the second question first, which is the
   * one way to get a person's approval for the wrong thing.
   */
  #enqueuePermission(id: RequestId, params: RequestPermissionRequest): void {
    this.#permissionQueue = this.#permissionQueue.then(() => this.#answerPermission(id, params));
  }

  async #answerPermission(id: RequestId, params: RequestPermissionRequest): Promise<void> {
    let response: RequestPermissionResponse;
    try {
      const optionId = await this.#gate.permission(params);
      response = optionId === null ? cancelledOutcome() : selectedOutcome(optionId);
    } catch (error) {
      // A gate that throws is a gate that did not approve. Anything else would turn a bug in the
      // decision path into an approval — so this fails closed like any other decline.
      this.#reportError('the permission gate threw, and the request was declined', error);
      response = cancelledOutcome();
    }
    this.#write(encodeSuccess(id, response));
  }

  #respondRefused(id: RequestId, error: Error): void {
    this.#write(encodeFailure(id, { code: ERROR_CODES.METHOD_NOT_FOUND, message: error.message }));
  }

  #pathOf(params: unknown): string {
    const path = (params as ReadTextFileRequest | WriteTextFileRequest | undefined)?.path;
    return typeof path === 'string' ? path : '<unknown path>';
  }

  #write(line: string): void {
    if (this.#closed) return;
    try {
      this.transport.write(line);
    } catch (error) {
      this.close(describeWriteFailure(error));
    }
  }

  /**
   * One way to report something that went wrong on our side of the wire.
   *
   * It takes *what* failed as a phrase rather than baking one failure into the message, because the
   * first version of this printed "a session-update listener failed" for a crashing permission
   * gate — a sentence naming a component that was not involved, sent at 23:00 to somebody trying
   * to work out why their approval never arrived. The phrase is the part that tells a reader where
   * to look.
   */
  #reportError(what: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kurier: ${what}: ${message}`);
  }

  /**
   * Reject everything in flight, once, when the peer is gone.
   *
   * Every rejection is **wrapped with the method that was waiting**. A bare "the agent process
   * ended" is true but useless at 23:00 with a hung terminal: what a person needs to know is which
   * call died. A clean close is the one exception — there the peer's own reason, if it gave one,
   * is the more useful half, so it is kept as the cause.
   */
  #failAll(reason: Error | undefined): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (reason) {
        pending.reject(new Error(`${pending.method} did not finish: ${reason.message}`, { cause: reason }));
      } else {
        pending.reject(new Error(`${pending.method} did not finish: the agent process ended`));
      }
    }
  }
}

/** The agent answered `initialize` with a version this client does not implement. */
export class ProtocolVersionMismatchError extends Error {
  readonly negotiated: number;
  readonly supported: number;
  readonly agentInfo: Implementation | undefined;

  constructor(negotiated: number | undefined, supported: number, agentInfo?: Implementation | null) {
    const who = agentInfo ? `${agentInfo.name} ${agentInfo.version}` : 'the agent';
    super(
      `${who} speaks ACP version ${negotiated ?? 'none'}, kurier implements version ${supported}. ` +
        'Refusing to continue — a mismatch found halfway through a turn is far more expensive.',
    );
    this.name = 'ProtocolVersionMismatchError';
    this.negotiated = Number(negotiated);
    this.supported = supported;
    this.agentInfo = agentInfo ?? undefined;
  }
}

/** The agent did not advertise a capability the caller needs. Never a guess. */
export class UnsupportedCapabilityError extends Error {
  readonly capabilities: Record<string, boolean>;

  constructor(message: string, capabilities: Record<string, boolean>) {
    super(message);
    this.name = 'UnsupportedCapabilityError';
    this.capabilities = capabilities;
  }
}

/** True when the error is ACP's "log in first" — the one that `kurier auth` exists for. */
export function isAuthRequired(error: unknown): boolean {
  return error instanceof RpcError && error.code === ERROR_CODES.AUTH_REQUIRED;
}

/** Flatten a content block to the text a transcript should keep. Non-text is summarised, not parsed. */
export function contentToText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource_link') return `[${block.name}](${block.uri})`;
  if (block.type === 'image') return '[image]';
  if (block.type === 'audio') return '[audio]';
  return '[resource]';
}

function describeWriteFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
