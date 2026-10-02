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
  type SessionConfigOption,
  type SessionMode,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from '@kurier/acp/types';

/**
 * The three options `opencode acp` 2.0.19 reports, with the shape it reports them in.
 *
 * **Values are cut down, structure is not.** The real answer carries ~400 models, and a fixture
 * that carried 400 would make every assertion about "the options" a test of a list nobody reads.
 * What matters is the *shape*: an id that is a `provider/model` string, a thought level whose
 * values are single words, and a mode with a `description` per value — because the description is
 * the only per-value text ACP has, and a surface that ignores it renders "plan" and "build" with
 * nothing to say what they do.
 *
 * `buildManyModelOptions` produces the real size on demand for the one case that needs it.
 */
export function opencodeConfigOptions(): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'openrouter/openai/gpt-6.1-sol',
      options: [
        { value: 'openrouter/openai/gpt-6.1-sol', name: 'gpt-6.1-sol' },
        { value: 'openrouter/anthropic/claude-sonnet-5.5', name: 'claude-sonnet-5.5' },
        { value: 'github-copilot/gpt-5.5-codex', name: 'gpt-5.5-codex' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      description: 'Available effort levels for this model',
      type: 'select',
      category: 'thought_level',
      currentValue: 'default',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'Extra high' },
        { value: 'max', name: 'Maximum' },
        { value: 'default', name: 'Default' },
      ],
    },
    {
      id: 'mode',
      name: 'Session Mode',
      type: 'select',
      category: 'mode',
      currentValue: 'build',
      options: [
        { value: 'build', name: 'Build', description: 'Make the change' },
        { value: 'plan', name: 'Plan', description: 'Propose before changing' },
      ],
    },
  ];
}

/**
 * The same three options with the model list **grouped** — the other arm of
 * `SessionConfigSelectOptions`' `anyOf` (`refs/acp/schema.v1.json`), which an agent is free to send and
 * `opencode` does not.
 *
 * **The one cast in this file, and it is the schema's shape rather than a convenience.**
 * `SessionConfigSelectOption` is the *flat* arm, so a `SessionConfigSelectGroup` has no home in the
 * typed wire type — a client that types the grouped arm away has no way to notice it arriving, and a
 * fixture that cannot express it cannot test that it is handled. `narrow.ts`'s `usableConfigValues` is
 * the single filter both arms go through, and this is what it is tested with.
 */
export function groupedConfigOptions(): SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'local/llama',
      options: [
        {
          group: 'local',
          name: 'Local',
          options: [
            { value: 'local/llama', name: 'llama' },
            { value: 'local/qwen', name: 'qwen' },
          ],
        },
        {
          group: 'hosted',
          name: 'Hosted',
          options: [
            { value: 'hosted/gpt-5.5', name: 'gpt-5.5' },
            { value: 'hosted/claude-sonnet-5.5', name: 'claude-sonnet-5.5' },
          ],
        },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      type: 'select',
      category: 'thought_level',
      currentValue: 'default',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'default', name: 'Default' },
      ],
    },
  ] as unknown as SessionConfigOption[];
}

/** The modes behind the `mode` config option. opencode keeps the two in step; so does this. */
export const OPENCODE_MODES: SessionMode[] = [
  { id: 'build', name: 'Build', description: 'Make the change' },
  { id: 'plan', name: 'Plan', description: 'Propose before changing' },
];

/** A model list the size a real account actually produces, for the "is it searchable" question. */
export function buildManyModelOptions(count = 400): SessionConfigOption[] {
  const options = Array.from({ length: count }, (_, index) => ({
    value: `openrouter/vendor/model-${String(index).padStart(3, '0')}`,
    name: `model-${String(index).padStart(3, '0')}`,
  }));
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: options[0]?.value,
      options,
    },
  ];
}

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
  /**
   * Answer `session/prompt` with `-32_000` and nothing else, while every other call succeeds.
   *
   * **Issue #2's shape, and the only way to reach it from a unit test.** Measured against `opencode acp`
   * 2.0.19 with no login: a geo-blocked provider turns `session/prompt` into
   * `-32000 "Authentication required: provider authentication required"` — the same class and the same
   * code as `requireAuth`, on an agent that handshook, loaded the session and answered. Nothing on the
   * wire separates them except that one has a prompt behind it, so a fixture that could only produce
   * `requireAuth` would let a client that shows the login dialog on this path pass.
   *
   * **`requireAuth` is untouched by it and they are independent**, because a client has to be able to
   * hold both facts: no prompt sent (a real login trap) and a prompt sent (a refusal). Passing both is
   * meaningless — `session/load` would fail first — and the option says so by not being exclusive.
   */
  promptAuth?: boolean;
  /** Send `_meta` on every response, plus an unknown capability marker, to prove passthrough. */
  chattyMeta?: boolean;
  /** How many pages `session/list` answers before the cursor runs out. Defaults to 1. */
  listPages?: number;
  /**
   * The options reported on `session/new`, `session/load`, `session/resume` and every
   * `session/set_config_option` answer. Defaults to opencode 2.0.19's three.
   *
   * Pass `[]` for an agent that has no configuration at all, which is a different client behaviour
   * from "an empty dropdown" and therefore a different test.
   */
  configOptions?: SessionConfigOption[];
  /** Reject a config option the fixture does not know, and a value outside the option's list. */
  strictConfigOptions?: boolean;
  /**
   * Refuse every set of these `configId`s, with the protocol's own error.
   *
   * **The only way to reach a refusal from a client, and that is why it exists.** Every *other*
   * refusal is the client's own doing — an unknown id or an unoffered value, both refused before the
   * request goes out — so without this a client could pass its whole suite and still have the failure
   * path untested. An agent that will not let a session's model change mid-conversation is a real
   * agent, and `opencode` 2.0.19 already refuses anything it does not recognise.
   */
  refuseConfigOptions?: string[];
  /**
   * Push a `config_option_update` after a successful set, the way opencode does when the **model**
   * changes (it does not for `effort` or `mode`). Defaults to true.
   */
  pushConfigOptionUpdate?: boolean;
  /** Never answer `initialize` — for the initialize timeout. */
  hangOnInitialize?: boolean;
  /**
   * Hold the turn open after its chunks, until `session/cancel` arrives or `releaseTurn()` is called.
   *
   * **Why a fixture needs this, when the fixture's turn is otherwise a burst of microtasks.** Without it
   * the turn is over before a caller can observe anything about it, so "Stop cancels the turn" can only
   * be asserted by reading a flag *after* the fact — and the flag says nothing about whether the state
   * machine left `thinking` when the turn answered or when the button was pressed. A real agent works
   * for seconds and answers `cancelled` when told to stop; holding the turn is what makes that shape
   * reproducible in a unit test.
   */
  holdTurn?: boolean;
  /**
   * Park the `session/load` reply until `releaseLoad()` is called.
   *
   * **This is the cold-agent shape, and it is the one a fast fixture otherwise cannot produce.**
   * `session/load` replays a session's whole history, so on a real agent it takes seconds — and it is
   * the *first* thing that happens after the handshake on the first prompt of a session, because
   * prompting is what causes the load. Without this option every test sees `bindAgent` resolve inside
   * the same microtask batch, so a Stop pressed while it is in flight is unreachable: the window
   * between "the handshake is done" and "the prompt is sent" has no width to be tested in. A defect
   * lived exactly there and survived every other test in this file — a Stop during the load was
   * dropped, the prompt went out anyway, and the agent answered in full while the surface believed
   * the person had cancelled.
   */
  holdLoad?: boolean;
  /**
   * Park the `session/set_config_option` answer until `releaseConfigAnswer()` is called, **capturing the
   * option list at the moment the request arrived**.
   *
   * **The "capturing" is the half that makes it useful.** A held reply whose body is assembled at
   * release time would carry the agent's *latest* state, and every assertion about it would pass whether
   * the client applied a notification that arrived meanwhile or ignored it. Snapshotting at arrival makes
   * the answer older than anything that lands while it waits — which is the state a client is really in
   * when an agent pushes a change and answers a request at the same time, and the only state in which
   * "the answer wins" and "the notification wins" are different answers.
   */
  holdConfigAnswer?: boolean;
  /** Ask for a file the client refused to answer, mid-turn. */
  requestFileSystem?: 'read' | 'write';
  /** Send a method the client has never heard of, right after the handshake. */
  sendUnknownMethod?: string;
}

type PermissionOutcome = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } };

/** What the agent said when it refused to set something. The `about` keys vary per refusal. */
export type ConfigRefusal = { message: string } & Record<string, unknown>;

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
  /** Every value the client set, in order — the assertion surface for a config option. */
  readonly configSets: { configId: string; value: unknown }[] = [];
  /** Every mode the client set, in order. `session/set_mode` and the `mode` option are two doors. */
  readonly modesSet: string[] = [];

  #options: FixtureAgentOptions;
  #reader = new MessageReader();
  #messageListener: TransportListener | undefined;
  #closeListener: CloseListener | undefined;
  #closed = false;
  #authenticated: boolean;
  #turnRunning = false;
  #cancelRequested = false;
  /** Releases a held turn. See `FixtureAgentOptions.holdTurn`. */
  #releaseTurn: (() => void) | null = null;
  /** The parked `session/load` reply, or `null`. See `FixtureAgentOptions.holdLoad`. */
  #releaseLoad: (() => void) | null = null;
  /** The parked `session/set_config_option` reply, or `null`. See `FixtureAgentOptions.holdConfigAnswer`. */
  #releaseConfigAnswer: (() => void) | null = null;
  #nextRequestId = 10_000;
  #pendingPermissions = new Map<RequestId, (outcome: PermissionOutcome) => void>();
  #sessions = new Map<string, { cwd: string; mcpServers: McpServer[] }>();
  #configOptions: SessionConfigOption[];
  #currentModeId = 'build';
  /** Every config-option refusal, so a test can assert *which* mistake the client made. */
  readonly #configErrors: ConfigRefusal[] = [];

  constructor(options: FixtureAgentOptions = {}) {
    this.#options = options;
    this.#authenticated = options.requireAuth !== true;
    this.#configOptions = options.configOptions ?? opencodeConfigOptions();
  }

  /** Every config-option refusal the fixture sent, in order. */
  get configErrors(): ConfigRefusal[] {
    return this.#configErrors;
  }

  /**
   * Push a `config_option_update` for any session, with one option moved first.
   *
   * **A named session, not "the current one", because that is what the test needs to ask.** opencode
   * announces child sessions, so an update for another session is a real thing on the wire; a fixture
   * that could only push its own would make "this update names somebody else's session" unreachable,
   * and a client that applied it would be showing a model picker with another conversation's model on it.
   */
  pushConfigOptionUpdate(sessionId: string, configId: string, value: string): void {
    this.#configOptions = this.#configOptions.map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option,
    );
    this.#update({
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: this.#configOptions },
    });
  }

  /** The options as the fixture currently stands — what a surface would have to re-read. */
  get configOptions(): SessionConfigOption[] {
    return this.#configOptions;
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
        this.#reply(id, { sessionId: SESSION_ID, ...this.#sessionState(), ...this.#meta() });
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
        if (this.#options.holdLoad) {
          // Park the reply, so the caller can act in the window a real load spends replaying history.
          this.#releaseLoad = () => {
            this.#releaseLoad = null;
            this.#reply(id, { ...this.#sessionState(), ...this.#meta() });
            for (const chunk of this.#options.chunks ?? ['replayed']) {
              this.#update({ sessionId, update: this.#agentChunk(chunk) });
            }
          };
          return;
        }
        this.#reply(id, { ...this.#sessionState(), ...this.#meta() });
        // A load replays the history as notifications. That is its whole purpose.
        for (const chunk of this.#options.chunks ?? ['replayed']) {
          this.#update({ sessionId, update: this.#agentChunk(chunk) });
        }
        return;
      }

      case CLIENT_METHODS.resumeSession: {
        if (!this.#authenticated) return this.#authRequired(id);
        this.#reply(id, { ...this.#sessionState(), ...this.#meta() });
        return;
      }

      case CLIENT_METHODS.setSessionMode: {
        if (!this.#authenticated) return this.#authRequired(id);
        const modeId = String(params?.['modeId'] ?? '');
        if (!OPENCODE_MODES.some((mode) => mode.id === modeId)) {
          return this.#configInvalid(id, 'no such mode', { modeId });
        }
        this.modesSet.push(modeId);
        this.#currentModeId = modeId;
        this.#syncModeOption();
        // The v1 response carries nothing. The new mode comes back as an update, so a client that
        // treats the acknowledgement as the state is guessing.
        this.#reply(id, this.#meta());
        this.#update({
          sessionId: String(params?.['sessionId'] ?? SESSION_ID),
          update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
        });
        return;
      }

      case CLIENT_METHODS.setSessionConfigOption: {
        if (!this.#authenticated) return this.#authRequired(id);
        this.#setConfigOption(id, params);
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
        if (this.#options.promptAuth === true) {
          // **The login trap's exact code, on an agent that is logged in and healthy.** Only the turn
          // state tells the two apart, and that is the point of the option — see `promptAuth`. No echo
          // and no chunk first, because the measured turn carries neither.
          this.#send(
            encodeFailure(id as RequestId, {
              code: -32_000,
              message: 'Authentication required: provider authentication required',
            }),
          );
          return;
        }
        const sessionId = String(params?.['sessionId'] ?? SESSION_ID);
        void this.#runTurn(id, sessionId, (params?.['prompt'] as ContentBlock[]) ?? []);
        return;
      }

      case CLIENT_NOTIFICATIONS.cancel:
        this.#cancelRequested = true;
        // A held turn is released by the cancel, which is the whole point of holding it: the client sees
        // the notification arrive, the turn then answers `cancelled` on its own, and a caller that left
        // `thinking` early is caught.
        this.#releaseTurn?.();
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
      if (this.#options.holdTurn) {
        // Park here until a cancel arrives or a test releases it. Nothing before this point awaits, so a
        // test that calls `stop()` between `prompt()` and `flush()` lands inside the hold.
        await new Promise<void>((resolve) => {
          this.#releaseTurn = resolve;
        });
        this.#releaseTurn = null;
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

  /**
   * The `modes` and `configOptions` every session-creating and session-reopening answer carries.
   *
   * `opencode acp` 2.0.19 sends both from `session/new`, `session/load` and `session/resume`, which
   * is what makes them re-readable: a surface that shows the current model after a restart is
   * reading the agent's answer, not remembering its own choice.
   */
  #sessionState(): Record<string, unknown> {
    return {
      modes: { currentModeId: this.#currentModeId, availableModes: OPENCODE_MODES },
      configOptions: this.#configOptions,
    };
  }

  /**
   * `session/set_config_option`, with the two behaviours of the real agent that a test has to be
   * able to reproduce:
   *
   * - **A non-string value is refused outright.** opencode 2.0.19 answers
   *   `InvalidConfigOptionError` for `typeof value !== "string"`, so it implements no boolean
   *   options at all. That is the measurement behind `KURIER_CLIENT_CAPABILITIES` omitting
   *   `session.configOptions.boolean`: announcing a shape the agent refuses is a promise the agent
   *   is entitled to break.
   * - **The answer is the full list, and it is the truth.** An unknown `configId` or a value outside
   *   the option is an error; anything else rewrites the option and returns every option again, so a
   *   client that kept its own guess instead of reading the answer can be caught.
   */
  #setConfigOption(id: RequestId | undefined, params: Record<string, unknown> | undefined): void {
    const configId = String(params?.['configId'] ?? '');
    const value = params?.['value'];
    if (typeof value !== 'string') {
      return this.#configInvalid(id, 'this agent takes a value id, not a tagged value', { configId });
    }
    if (this.#options.refuseConfigOptions?.includes(configId) === true) {
      return this.#configInvalid(id, 'this session cannot change this option', { configId });
    }
    this.configSets.push({ configId, value });

    if (configId === 'mode') {
      if (!OPENCODE_MODES.some((mode) => mode.id === value)) {
        return this.#configInvalid(id, 'no such mode', { configId, value });
      }
      this.#currentModeId = value;
      this.modesSet.push(value);
      this.#syncModeOption();
      return this.#replyWithOptions(id, params, false);
    }

    const index = this.#configOptions.findIndex((option) => option.id === configId);
    if (index === -1) {
      return this.#configInvalid(id, 'no such config option', { configId });
    }
    const option = this.#configOptions[index] as SessionConfigOption;
    if (option.type === 'select') {
      const values = (option.options ?? []).map((entry) => entry.value);
      if (!values.includes(value)) {
        return this.#configInvalid(id, 'that value is not one of the offered ones', { configId, value });
      }
    }
    this.#configOptions = [
      ...this.#configOptions.slice(0, index),
      { ...option, currentValue: value },
      ...this.#configOptions.slice(index + 1),
    ];
    // opencode pushes an update for a **model** change and returns the list for the others. Both,
    // here: a client has to cope with either and must not depend on the notification arriving.
    return this.#replyWithOptions(id, params, configId === 'model');
  }

  #replyWithOptions(
    id: RequestId | undefined,
    params: Record<string, unknown> | undefined,
    push: boolean,
  ): void {
    // **Snapshot before parking.** `holdConfigAnswer` exists so a caller can decide what to do with a
    // notification that lands while a set is in flight, and that decision is only observable if the
    // parked answer is older than the notification — see `FixtureAgentOptions.holdConfigAnswer`.
    const snapshot = this.#configOptions.map((option) => ({ ...option }));
    if (this.#options.holdConfigAnswer === true) {
      this.#releaseConfigAnswer = () => {
        this.#releaseConfigAnswer = null;
        this.#reply(id, { configOptions: snapshot, ...this.#meta() });
      };
      return;
    }
    this.#reply(id, { configOptions: snapshot, ...this.#meta() });
    if (push && this.#options.pushConfigOptionUpdate !== false) {
      this.#update({
        sessionId: String(params?.['sessionId'] ?? SESSION_ID),
        update: { sessionUpdate: 'config_option_update', configOptions: this.#configOptions },
      });
    }
  }

  /** Keep the `mode` option's `currentValue` in step with `session/set_mode`. */
  #syncModeOption(): void {
    this.#configOptions = this.#configOptions.map((option) =>
      option.id === 'mode' ? { ...option, currentValue: this.#currentModeId } : option,
    );
  }

  /**
   * The refusal `opencode acp` gives for a config option it cannot set, as a real error response.
   *
   * A response and not a silent drop: a client that gets no answer to `session/set_config_option`
   * waits forever, and a fixture that hangs is a fixture that cannot test a failure.
   */
  #configInvalid(id: RequestId | undefined, message: string, about: Record<string, unknown>): void {
    this.#configErrors.push({ message, ...about });
    this.#send(
      encodeFailure(id as RequestId, {
        code: ERROR_CODES.INVALID_PARAMS,
        message: `${message}: ${JSON.stringify(about)}`,
      }),
    );
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

  /**
   * Let a held turn finish on its own. Only meaningful with `holdTurn`; the alternative to a cancel,
   * so a test can tell "ended because stopped" from "ended because it was done".
   */
  releaseTurn(): void {
    this.#releaseTurn?.();
  }

  /**
   * Let a parked `session/load` answer. Only meaningful with `holdLoad`; it opens the window between
   * the handshake and the prompt, which is where a Stop can be pressed and lost.
   */
  releaseLoad(): void {
    this.#releaseLoad?.();
  }

  /**
   * Let a parked `session/set_config_option` answer, with the option list as it was when the request
   * arrived. Only meaningful with `holdConfigAnswer`.
   */
  releaseConfigAnswer(): void {
    this.#releaseConfigAnswer?.();
  }
}
