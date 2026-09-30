/**
 * A fixture agent: a real ACP peer that lives in this process.
 *
 * It exists because the honest test of a protocol client is the wire, and a wire needs two ends.
 * Spawning a real agent for every unit test would make the suite slow, network-shaped and
 * dependent on somebody's model quota — so the Node suites run against this, and exactly one
 * integration test (`app/tests/integration/acp-real-agent.ts`) spawns a real agent under GJS to
 * prove the stdio path end to end.
 *
 * It is a **fixture, not a mock**: it speaks the protocol as the schema says, including the parts
 * that are inconvenient — a capability marker the schema has never heard of, `_meta` it invented, a
 * permission request in the middle of a turn, a paginated `session/list`. A client that only passes
 * against a polite peer is not tested.
 *
 * Measured against `opencode acp` 2.0.19, and deliberately kept as close to it as the schema allows:
 * see `app/tests/unit/acp/opencode-shape.test.ts`, which asserts this fixture still describes that
 * agent — when the agent changes, that test is the reminder, not this file's comment.
 */

import {
  MessageReader,
  encodeFailure,
  encodeNotification,
  encodeSuccess,
  type JsonRpcMessage,
} from '@kurier/acp/jsonrpc';
import {
  AGENT_METHODS,
  AGENT_NOTIFICATIONS,
  CLIENT_METHODS,
  CLIENT_NOTIFICATIONS,
} from '@kurier/acp/methods';
import type { CloseListener, Transport, TransportListener } from '@kurier/acp/transport';
import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethodInfo,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type PermissionOption,
  type RequestId,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from '@kurier/acp/types';

export interface FixtureAgentOptions {
  /** What `initialize` reports. The defaults are opencode 2.0.19's, warts included. */
  capabilities?: Partial<AgentCapabilities>;
  authMethods?: AuthMethodInfo[];
  /** Advertise `loadSession: false` and only `sessionCapabilities.resume` — trap 2's shape. */
  omitLoadSession?: boolean;
  protocolVersion?: number;
  /** Answer `session/prompt` with this. Defaults to `end_turn`. */
  stopReason?: StopReason;
  /** Emit this many agent message chunks per turn. Defaults to one. */
  chunks?: string[];
  /**
   * Ask for permission once per prompt turn, offering these options. Empty (the default) means the
   * gate is never called — so "the gate is not consulted" and "the gate decides" are one option
   * apart, and both are testable.
   */
  permissionOptions?: PermissionOption[];
  /**
   * How many permission requests ONE turn sends, all at once without waiting for the answers.
   *
   * Defaults to 1, which is polite. The point of `> 1` is the client's queue: with a sequential
   * fixture, a client that delivered both requests to the gate at once would still pass, so only
   * the burst can tell serialisation from luck.
   */
  permissionBurst?: number;
  /** Refuse every call with `-32_000 auth_required` until `authenticate` arrived. Trap 1's shape. */
  requireAuth?: boolean;
  /** Send `_meta` on every response, plus an unknown capability marker, to prove passthrough. */
  chattyMeta?: boolean;
  /** How many pages `session/list` answers before the cursor runs out. Defaults to 1. */
  listPages?: number;
  /** Never answer `initialize` — for the initialize timeout. */
  hangOnInitialize?: boolean;
  /** Ask for a file the client refused to answer, mid-turn. */
  requestFileSystem?: 'read' | 'write';
  /** Send a method the client has never heard of, right after the handshake. */
  sendUnknownMethod?: string;
}

type PermissionOutcome = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } };

const SESSION_ID = 'ses_fixture_0001';

export class FixtureAgent {
  /** Every request and notification the client sent, in order. The assertion surface. */
  readonly sent: { method: string; params: unknown }[] = [];
  /** Every permission request the fixture made, in order. */
  readonly permissionAsked: PermissionOption[][] = [];
  /** The outcome the client chose for each permission request, in order. */
  readonly permissionOutcomes: (PermissionOutcome | undefined)[] = [];
  /** Every error response the fixture sent back, for the "agent keeps talking" assertions. */
  readonly refused: { path: string }[] = [];

  #options: FixtureAgentOptions;
  #reader = new MessageReader();
  #messageListener: TransportListener | undefined;
  #closeListener: CloseListener | undefined;
  #closed = false;
  #authenticated: boolean;
  #turnRunning = false;
  #cancelRequested = false;
  #nextRequestId = 10_000;
  #pendingPermissions = new Map<RequestId, (outcome: PermissionOutcome) => void>();
  #sessions = new Map<string, { cwd: string; mcpServers: McpServer[] }>();

  constructor(options: FixtureAgentOptions = {}) {
    this.#options = options;
    this.#authenticated = options.requireAuth !== true;
  }

  /** The client under test. */
  readonly transport: Transport = {
    get closed() {
      return false;
    },
    // The `MessageReader` this fixture feeds through `#receive` is line-oriented, same as the
    // real stdio wire — it never emits a message until it sees `\n`. `Transport.write`'s own
    // contract says the newline is the implementation's job, not the caller's, so this fixture
    // has to add it exactly like `StdioChannel.send` does.
    write: (data: string) => this.#receive(`${data}\n`),
    onMessage: (listener: TransportListener) => {
      this.#messageListener = listener;
    },
    onClose: (listener: CloseListener) => {
      this.#closeListener = listener;
    },
    close: () => this.#shutdown(),
  };

  get closed(): boolean {
    return this.#closed;
  }

  /** Calls of one method, in order. */
  calls(method: string): { method: string; params: unknown }[] {
    return this.sent.filter((entry) => entry.method === method);
  }

  /** Drop the peer without a clean close, so the client's pending requests must reject. */
  vanish(reason = 'the agent process ended'): void {
    this.#closed = true;
    this.#closeListener?.(new Error(reason));
  }

  // ─── the client half ───────────────────────────────────────────────────────────────────────

  #receive(chunk: string): void {
    for (const message of this.#reader.push(chunk)) this.#handle(message);
  }

  #handle(message: JsonRpcMessage): void {
    if (!('method' in message)) {
      this.#settlePermission(message.id, (message as { result?: PermissionOutcome }).result);
      return;
    }
    const id = 'id' in message ? message.id : undefined;
    const params = message.params as Record<string, unknown> | undefined;
    this.sent.push({ method: message.method, params });

    switch (message.method) {
      case CLIENT_METHODS.initialize:
        if (this.#options.hangOnInitialize) return;
        this.#reply(id, this.#initializeResult());
        this.#afterHandshake();
        return;

      case CLIENT_METHODS.authenticate:
        this.#authenticated = true;
        this.#reply(id, {});
        return;

      case CLIENT_METHODS.logout:
        this.#authenticated = false;
        this.#reply(id, {});
        return;

      case CLIENT_METHODS.newSession: {
        if (!this.#authenticated) return this.#authRequired(id);
        const cwd = String(params?.['cwd'] ?? '');
        const mcpServers = (params?.['mcpServers'] ?? []) as McpServer[];
        this.#sessions.set(SESSION_ID, { cwd, mcpServers });
        this.#reply(id, { sessionId: SESSION_ID, ...this.#meta() });
        // A real agent announces its slash commands unprompted, before the first prompt turn.
        this.#update({
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'init', description: 'guided AGENTS.md setup' }],
          },
        });
        return;
      }

      case CLIENT_METHODS.loadSession: {
        if (!this.#authenticated) return this.#authRequired(id);
        if (this.#options.omitLoadSession) return this.#methodNotFound(id, message.method);
        const sessionId = String(params?.['sessionId'] ?? SESSION_ID);
        this.#reply(id, this.#meta());
        // A load replays the history as notifications. That is its whole purpose.
        for (const chunk of this.#options.chunks ?? ['replayed']) {
          this.#update({ sessionId, update: this.#agentChunk(chunk) });
        }
        return;
      }

      case CLIENT_METHODS.resumeSession: {
        if (!this.#authenticated) return this.#authRequired(id);
        this.#reply(id, this.#meta());
        return;
      }

      case CLIENT_METHODS.listSessions: {
        if (!this.#authenticated) return this.#authRequired(id);
        this.#reply(id, this.#listResult(params?.['cursor']));
        return;
      }

      case CLIENT_METHODS.closeSession:
      case CLIENT_METHODS.deleteSession:
        if (!this.#authenticated) return this.#authRequired(id);
        this.#reply(id, this.#meta());
        return;

      case CLIENT_METHODS.prompt: {
        if (!this.#authenticated) return this.#authRequired(id);
        const sessionId = String(params?.['sessionId'] ?? SESSION_ID);
        void this.#runTurn(id, sessionId, (params?.['prompt'] as ContentBlock[]) ?? []);
        return;
      }

      case CLIENT_NOTIFICATIONS.cancel:
        this.#cancelRequested = true;
        return;

      default:
        this.#send(
          encodeFailure(id as RequestId, {
            code: ERROR_CODES.METHOD_NOT_FOUND,
            message: `fixture agent implements no method "${message.method}"`,
          }),
        );
    }
  }

  async #runTurn(id: RequestId | undefined, sessionId: string, prompt: ContentBlock[]): Promise<void> {
    this.#turnRunning = true;
    this.#cancelRequested = false;
    try {
      this.#update({
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: prompt[0] ?? { type: 'text', text: '' } },
      });
      for (const chunk of this.#options.chunks ?? ['answer']) {
        if (this.#cancelRequested) break;
        this.#update({ sessionId, update: this.#agentChunk(chunk) });
      }
      if (this.#cancelRequested) {
        this.#reply(id, { stopReason: 'cancelled' });
        return;
      }
      if (this.#options.requestFileSystem) {
        const asked = this.#askFileSystem(sessionId, this.#options.requestFileSystem);
        // The real agent waits for the answer, and a client that leaves a request unanswered hangs
        // the turn — so the fixture waits too, for a few turns of the loop.
        for (let i = 0; i < 10 && !this.#closed; i++) await Promise.resolve();
        if (!asked) this.#reply(id, { stopReason: 'refusal' });
      }
      if (this.#cancelRequested) {
        this.#reply(id, { stopReason: 'cancelled' });
        return;
      }
      const permissionOptions = this.#options.permissionOptions ?? [];
      if (permissionOptions.length > 0) {
        // A burst asks N times WITHOUT waiting for an answer to the first, which is how an agent
        // doing parallel tool calls behaves and is the case the client's queue exists for. A
        // sequential fixture would pass whether the client serialised or not, so this is the only
        // version of this that can catch the bug.
        const burst = Math.max(1, this.#options.permissionBurst ?? 1);
        const pending: Promise<PermissionOutcome>[] = [];
        for (let i = 0; i < burst; i++) {
          pending.push(this.#askPermission(sessionId, permissionOptions, `call_${i + 1}`));
        }
        const outcomes = await Promise.all(pending);
        if (outcomes.some((outcome) => outcome?.outcome.outcome !== 'selected')) {
          this.#reply(id, { stopReason: 'refusal' });
          return;
        }
      }
      this.#reply(id, { stopReason: this.#options.stopReason ?? ('end_turn' satisfies StopReason) });
    } finally {
      this.#turnRunning = false;
      this.#cancelRequested = false;
    }
  }

  #askFileSystem(sessionId: string, kind: 'read' | 'write'): boolean {
    const method = kind === 'read' ? AGENT_METHODS.readTextFile : AGENT_METHODS.writeTextFile;
    this.#send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: this.#nextRequestId++,
        method,
        params: { sessionId, path: '/etc/shadow', ...(kind === 'write' ? { content: 'x' } : {}) },
      }),
    );
    return true;
  }

  #askPermission(
    sessionId: string,
    options: PermissionOption[],
    toolCallId = 'call_1',
  ): Promise<PermissionOutcome> {
    const id = this.#nextRequestId++;
    let settle!: (outcome: PermissionOutcome) => void;
    const answer = new Promise<PermissionOutcome>((resolve) => {
      settle = resolve;
    });
    this.#pendingPermissions.set(id, settle);
    this.permissionAsked.push(options);
    this.#send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: AGENT_METHODS.requestPermission,
        params: {
          sessionId,
          toolCall: { toolCallId, title: `write a file (${toolCallId})`, kind: 'edit', status: 'pending' },
          options,
          ...this.#meta(),
        },
      }),
    );
    return answer;
  }

  #settlePermission(id: RequestId, result: PermissionOutcome | undefined): void {
    const settle = this.#pendingPermissions.get(id);
    if (!settle) return;
    this.#pendingPermissions.delete(id);
    this.permissionOutcomes.push(result);
    settle(result ?? { outcome: { outcome: 'cancelled' } });
  }

  #afterHandshake(): void {
    if (this.#options.sendUnknownMethod) {
      this.#send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: this.#nextRequestId++,
          method: this.#options.sendUnknownMethod,
          params: { note: 'from the future' },
        }),
      );
    }
  }

  // ─── the agent half ────────────────────────────────────────────────────────────────────────

  #initializeResult(): InitializeResponse {
    const capabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: true, sse: false },
      // `fork` is deliberately ahead of the v1 schema — opencode 2.0.19 sends it and the schema
      // does not define it. See `opencode-shape.test.ts`, which pins this fixture to that shape.
      sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} },
      auth: {},
      ...(this.#options.omitLoadSession ? { loadSession: false } : {}),
      ...this.#options.capabilities,
    };
    return {
      protocolVersion: this.#options.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      authMethods: this.#options.authMethods ?? [],
      agentInfo: { name: 'FixtureAgent', version: '0.1.0' },
      ...this.#meta(),
    };
  }

  #listResult(cursor: unknown): unknown {
    const pages = this.#options.listPages ?? 1;
    const index = typeof cursor === 'string' ? Number.parseInt(cursor, 10) : 0;
    const session = (n: number) => ({
      sessionId: `${SESSION_ID}_p${n}`,
      cwd: '/fixture',
      title: `Session ${n}`,
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    if (index >= pages - 1) return { sessions: [session(index)], nextCursor: null, ...this.#meta() };
    return { sessions: [session(index)], nextCursor: String(index + 1), ...this.#meta() };
  }

  #agentChunk(text: string): SessionUpdate {
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
  }

  #update(notification: SessionNotification): void {
    this.#send(encodeNotification(AGENT_NOTIFICATIONS.sessionUpdate, notification));
  }

  #reply(id: RequestId | undefined, result: unknown): void {
    if (id === undefined) return;
    this.#send(encodeSuccess(id, result ?? {}));
  }

  #authRequired(id: RequestId | undefined): void {
    if (id === undefined) return;
    this.#send(
      encodeFailure(id, {
        code: ERROR_CODES.AUTH_REQUIRED,
        message: 'this agent needs authentication before it creates a session',
      }),
    );
  }

  #methodNotFound(id: RequestId | undefined, method: string): void {
    if (id === undefined) return;
    this.#send(encodeFailure(id, { code: ERROR_CODES.METHOD_NOT_FOUND, message: `no ${method}` }));
  }

  #meta(): Record<string, unknown> {
    return this.#options.chattyMeta ? { _meta: { 'fixture/noise': true } } : {};
  }

  #send(line: string): void {
    if (this.#closed) return;
    this.#messageListener?.(`${line}\n`);
  }

  #shutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeListener?.(undefined);
  }

  /** True while a prompt turn is in flight. Lets a test cancel precisely. */
  get turnRunning(): boolean {
    return this.#turnRunning;
  }
}
