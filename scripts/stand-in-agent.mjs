#!/usr/bin/env node
/**
 * The stand-in agent: a real ACP peer, in a couple of hundred lines of plain Node, that costs nothing
 * to talk to.
 *
 * **Why this file exists.** A real turn against a real agent costs the person's model quota and is not
 * reproducible: the same prompt takes three seconds or three minutes, produces different text every
 * time, and cannot be screenshotted on demand. Plan §7 step 5 has to be *looked at* — a streaming turn,
 * a Stop, an agent that dies mid-turn — and none of those are reachable twice in a row against
 * `opencode`. So the surface is developed and verified against this, and the protocol is not simplified
 * for it: the framing, the method names and the `initialize` answer are the real ones, taken from
 * `packages/acp/src/jsonrpc.ts`, `packages/acp/src/methods.ts` and the measured handshake in
 * `AGENTS.md`. A fixture that spoke a friendlier dialect would pass here and fail against the first
 * real agent.
 *
 * **The framing is newline-delimited JSON, not `Content-Length` headers.** Worth stating because LSP
 * uses the headers and a reader skimming for them will reach for them: ACP's stdio transport is one
 * JSON value per line — `jsonrpc.ts`'s file header says so, and `MessageReader` is the parser kurier
 * uses against real agents. So this script appends `\n` and nothing else.
 *
 * It speaks `initialize`, `session/new`, `session/load`, `session/resume`, `session/set_mode`,
 * `session/set_config_option`, `session/prompt` and `session/cancel`, and pushes `session/update`.
 * Anything else gets the protocol's own "method not found", which is what an agent kurier has never
 * heard of deserves.
 *
 * ## Switches — all from the environment, all defaulting to a turn that finishes normally
 *
 * | Variable                   | Default | What it does                                                         |
 * | -------------------------- | ------- | -------------------------------------------------------------------- |
 * | `KU_STANDIN_DELAY_MS`      | `350`   | Pause between streamed notifications. `0` makes a turn instant.       |
 * | `KU_STANDIN_CHUNKS`        | `4`     | How many of the answer's 4 sentences to stream. More is not more.     |
 * | `KU_STANDIN_ECHO`          | `1`     | Echo the prompt as `user_message_chunk`, as every real agent does.     |
 * | `KU_STANDIN_HANG`          | unset   | **Never** end the turn on its own — Stop has something to stop.       |
 * | `KU_STANDIN_EXIT_MID_TURN` | unset   | **Exit the process** partway through, answering nothing.               |
 * | `KU_STANDIN_PERMISSION`    | unset   | **Ask** `session/request_permission` mid-turn, and wait for the answer. |
 * | `KU_STANDIN_CONFIG`        | unset   | Report a model / effort / mode row and answer `session/set_config_option`. |
 * | `KU_STANDIN_CONFIG_MODELS` | `3`     | How many models the list holds. `400` is the real size, and needs search.  |
 * | `KU_STANDIN_CONFIG_REFUSE`  | unset   | Refuse every configuration change — the fail-closed state.                  |
 * | `KU_STANDIN_CONFIG_PUSH`    | `1`     | Push `config_option_update` after a *model* change, as `opencode` does.    |
 * | `KU_STANDIN_USAGE`          | unset   | Push a `usage_update` after the answer, cost and all.                     |
 * | `KU_STANDIN_AUTH`           | unset   | Refuse `session/load` with `-32000` — trap 1, the auth dialog.        |
 * | `KU_STANDIN_PROMPT_AUTH`    | unset   | Refuse `session/prompt` with the same `-32000` — issue #2, the model dialog. |
 * | `KU_STANDIN_NO_RESUME`      | unset   | Offer neither `loadSession` nor `resume` — trap 2, the refusal dialog. |
 *
 * ```sh
 * KURIER_SESSIONS_FILE=<file> KU_APP_SESSION=<id> KU_APP_AGENT=stand-in \
 *   ./node_modules/.bin/gjsify workspace lotse-cli start:app
 *
 * # the configuration row, and the three states only this fixture can produce
 * KU_STANDIN_CONFIG=1 KU_STANDIN_CONFIG_MODELS=400 KU_APP_CONFIG=model=openrouter/vendor/model-012
 * KU_STANDIN_CONFIG=1 KU_APP_CONFIG=effort=high        # the push arm: no update, the answer carries it
 * KU_STANDIN_CONFIG=1 KU_STANDIN_CONFIG_REFUSE=1 KU_APP_CONFIG=mode=plan   # the refusal
 * ```
 *
 * Exit code 0 on a normal shutdown, 3 for the deliberate mid-turn exit, so a test can tell them apart.
 */

import { createInterface } from 'node:readline';

const DELAY_MS = number('KU_STANDIN_DELAY_MS', 350);
/**
 * How many of the answer's four sentences to stream. Default 4, i.e. all of them.
 *
 * **A prefix, so it can only ever shorten.** `ANSWER` below is a list of four fixed sentences and
 * `runTurn` takes `ANSWER.slice(0, max(1, CHUNKS))` — a value above 4 is the same four sentences, not a
 * longer answer, which is why the default is the list's own length and not a round number above it.
 * The knob is for a *shorter* reply: a turn that is still arriving, where the newest bubble is below
 * the fold. It was 5 against a list of four, which read as a knob that grew and could not.
 */
const CHUNKS = number('KU_STANDIN_CHUNKS', 4);
const HANG = flag('KU_STANDIN_HANG');
const EXIT_MID_TURN = flag('KU_STANDIN_EXIT_MID_TURN');
const PERMISSION = flag('KU_STANDIN_PERMISSION');
const ECHO = flag('KU_STANDIN_ECHO', true);
const CONFIG = flag('KU_STANDIN_CONFIG');
const CONFIG_MODELS = number('KU_STANDIN_CONFIG_MODELS', 3);
const CONFIG_REFUSE = flag('KU_STANDIN_CONFIG_REFUSE');
const CONFIG_PUSH = flag('KU_STANDIN_CONFIG_PUSH', true);
const USAGE = flag('KU_STANDIN_USAGE');
const AUTH = flag('KU_STANDIN_AUTH');
const PROMPT_AUTH = flag('KU_STANDIN_PROMPT_AUTH');
const NO_RESUME = flag('KU_STANDIN_NO_RESUME');

/**
 * The configuration this script offers, built once here and then rewritten by every set.
 *
 * **`null` when `KU_STANDIN_CONFIG` is unset, and that is a state worth having.** An agent with no
 * configuration answers `session/new` with `configOptions: null` rather than an empty list, and the row
 * has to draw nothing for both. Assigned at the top rather than in a handler: `let` has a temporal dead
 * zone, and building it further down meant the first `session/new` could land before it existed.
 */
let configOptions = CONFIG ? buildConfigOptions() : null;

/** Fixed, so two screenshots are comparable. `session/load` keeps whatever id it was asked for. */
const SESSION_ID = 'ses_standin_0001';

/**
 * A fresh id per `session/new`: the first is `SESSION_ID`, so a one-chat run is unchanged, and the next
 * ones are numbered. Two New chats in one window would otherwise answer the same id, and the store
 * refuses a record that already exists.
 */
let sessionsCreated = 0;
function newSessionId() {
  sessionsCreated += 1;
  return sessionsCreated === 1 ? SESSION_ID : `${SESSION_ID}_${sessionsCreated}`;
}
const TOOL_CALL_ID = 'standin_read_1';

/**
 * The measured `initialize` answer (`AGENTS.md`, "The measured handshake"), with this script's own
 * name in `agentInfo`.
 *
 * `fork` is deliberately present and absent from the v1 schema, because `opencode acp` 2.0.19 sends it
 * and a client that rejected an unknown marker would break on the first real agent (guardrail 4).
 */
const AGENT_INFO = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    // **Trap 2's shape, behind a knob.** `loadSession: false` *and* no `resume` capability is what
    // `AcpClient.reattach` rejects with `UnsupportedCapabilityError`, and it is the case plan §6 asks
    // to be shown as a refusal rather than as an empty transcript.
    ...(NO_RESUME ? {} : { sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} } }),
    ...(NO_RESUME ? { loadSession: false } : {}),
    auth: {},
  },
  // No `authMethods`: this fixture never demands a login, because a turn that just works is the point.
  // The unauthenticated case is `FixtureAgent({ requireAuth: true })` in the unit suite.
  authMethods: [],
  agentInfo: { name: 'KurierStandIn', version: '0.1.0' },
};

/**
 * What a turn streams, in order: a thought, a tool call with its update, then the answer in chunks.
 *
 * Split into three kinds on purpose — `agent_thought_chunk`, `tool_call` + `tool_call_update`, and
 * `agent_message_chunk` — because those are the three shapes `core/transcript.ts` turns into three
 * different widgets, and a fixture that only streamed one of them would leave two rows of the window
 * unlooked at.
 */
const OPENING = [
  { thought: 'The person asked a question, so the answer is one sentence and the reason behind it.' },
  { tool: 'read README.md', status: 'pending' },
  { toolUpdate: 'read README.md', status: 'completed' },
];

const ANSWER = [
  'This is the stand-in agent. ',
  'It answers without a model, without a network and without a quota, ',
  'so the window can be looked at as often as the surface changes. ',
  'Everything it says is fixed text — which is the point: two runs produce two comparable screenshots.',
];

/** The notifications a client sends without an id, so an unknown one is not answered as a request. */
const CLIENT_NOTIFICATIONS = new Set(['session/cancel']);

const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

/** The turn in flight, so `session/cancel` can end it and nothing else has to. */
let turn = null;

/** The client's answer to a request this script sent, keyed by the id it sent. */
const pending = new Map();

/** Ids for requests the *agent* sends. The client's own ids are its business; these are ours. */
let nextRequestId = 1_000_000;

/**
 * Ask the client to run a tool, and wait for what it says.
 *
 * **A request the agent makes of the client, in the direction the schema has it.** The options are
 * every `session/request_permission` kind kurier can show, by default all four: a fixture that only
 * offered `allow_once`/`reject_once` would let a dialog that renders `allow_always` — and the ordering,
 * styling and focus rules that go with it — pass against a stand-in that never sent one.
 *
 * Resolves with whatever came back, `null` for an error answer — **including a `cancelled` outcome,
 * which is a real answer and not a failure here.** That is the point: `KU_STANDIN_PERMISSION=1` plus
 * an Escape on the dialog must end the turn cleanly, and a fixture that treated `cancelled` as an
 * error would hide exactly the behaviour this exists to look at.
 */
function askPermission(sessionId) {
  const id = nextRequestId++;
  const answer = new Promise((resolve) => {
    pending.set(id, resolve);
  });
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: `${TOOL_CALL_ID}_write`,
        status: 'pending',
        title: 'Write src/greeting.ts',
        kind: 'edit',
        locations: [{ path: 'src/greeting.ts', line: 3 }],
        rawInput: {
          path: 'src/greeting.ts',
          content: "export const greeting = 'hello from the stand-in agent';\n",
        },
      },
      options: permissionOptions(),
    },
  });
  return answer;
}

/**
 * The options this permission request carries, on the wire in the order a real agent would send them.
 *
 * **The knob is for the *order* and for the *set*, not for whether "always" exists.** `KU_STANDIN_PERMISSION_ONCE=1`
 * sends only the two `*_once` kinds — which is what an agent that offers no lasting grant looks like,
 * and the one shape kurier's dialog has no `reject` to fall back on in a two-allow list. `KU_STANDIN_PERMISSION_ALWAYS_FIRST=1`
 * lists the two `*_always` options *first*, the order that used to decide where libadwaita put the
 * focus, so a screenshot can show kurier's order winning rather than the agent's.
 *
 * Default all four, in the order a real agent sends them (`opencode acp` included), so the plain
 * `KU_STANDIN_PERMISSION=1` photographs the dialog kurier actually shows. `reject_always` never goes
 * missing from the default: without a rejecting option the dialog has nothing safe to focus, and that
 * is a state worth being able to reach — which is what `KU_STANDIN_PERMISSION_ONCE=1` plus
 * `KU_STANDIN_PERMISSION_NO_REJECT=1` is for.
 */
function permissionOptions() {
  const allowOnce = { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' };
  const allowAlways = {
    optionId: 'allow_always',
    name: 'Always allow in this session',
    kind: 'allow_always',
  };
  const rejectOnce = { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' };
  const rejectAlways = {
    optionId: 'reject_always',
    name: 'Always decline in this session',
    kind: 'reject_always',
  };
  if (flag('KU_STANDIN_PERMISSION_ONCE')) return [allowOnce, rejectOnce];
  if (flag('KU_STANDIN_PERMISSION_ALWAYS_FIRST')) {
    return [allowAlways, rejectAlways, allowOnce, rejectOnce];
  }
  if (flag('KU_STANDIN_PERMISSION_NO_REJECT')) return [allowOnce, allowAlways];
  return [allowOnce, allowAlways, rejectOnce, rejectAlways];
}

/** Match an incoming answer to the request that is waiting for it. */
function settlePending(message) {
  const resolve = pending.get(message.id);
  if (resolve === undefined) return;
  pending.delete(message.id);
  resolve(message.error ? null : (message.result ?? null));
}

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // A line we cannot read is not answered. Guessing an id would be worse than silence, and silence is
    // what a real peer gives on garbage.
    return;
  }
  // **A response, not a request.** `session/request_permission` goes the other way — the agent asks
  // the client — so its answer arrives here as a message with an `id`, a `result` and no `method`.
  // Answering it with "method not found" would be the wrong half of the protocol handled backwards,
  // and the gate would hang forever instead of failing closed.
  if (
    typeof message === 'object' &&
    message !== null &&
    message.method === undefined &&
    message.id !== undefined
  ) {
    return settlePending(message);
  }
  if (typeof message !== 'object' || message === null || message.method === undefined) return;
  if (message.id === undefined && !CLIENT_NOTIFICATIONS.has(message.method)) return;
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize':
      return reply(id, AGENT_INFO);
    case 'authenticate':
    case 'logout':
      return reply(id, {});
    case 'session/new':
      return reply(id, sessionState(newSessionId()));
    case 'session/load':
    case 'session/resume':
      // **Trap 1, in the shape a real unauthenticated agent has it.** `-32000` is the code kurier's
      // `isAuthRequired` matches and `withAuthHint` turns into a `lotse auth` sentence, and it is
      // refused *after* `initialize` succeeded — which is the point: the handshake works and the
      // session does not, so the failure cannot be caught anywhere earlier than the reattach.
      if (AUTH) return replyError(id, -32_000, 'Authentication required: run `opencode auth login`');
      // The id the client asked for: kurier prompts the session its store holds, not this script's.
      // No history is replayed — a real agent does, and kurier deliberately does not record that
      // replay; see `AgentSession.#bindAgent`.
      return reply(id, sessionState(String(params.sessionId ?? SESSION_ID)));
    case 'session/set_mode':
      // `session/set_mode` is the *other* door to the mode, and kurier does not use it (the config row
      // sets `mode` as a config option, see `core/config-row.ts`). It is answered by moving the mode
      // option anyway, so the two doors a real agent keeps in step stay in step here too — otherwise a
      // future caller of this door would see a mode that never changed.
      return setMode(String(params.sessionId ?? SESSION_ID), String(params.modeId ?? 'build'), id);
    case 'session/set_config_option':
      return setConfigOption(String(params.sessionId ?? SESSION_ID), params, id);
    case 'session/cancel':
      // A notification, so nothing comes back: the schema says a client that sends it must answer the
      // turn itself, and this script does that in `runTurn` when it wakes up. That is also why kurier's
      // Stop is "send the notification, then wait for the answer" and never a signal.
      cancelTurn();
      return;
    case 'session/prompt':
      void runTurn(id, String(params.sessionId ?? SESSION_ID), params.prompt ?? []);
      return;
    default:
      return replyError(id, -32_601, `the stand-in agent implements no method "${method}"`);
  }
});

input.on('close', () => {
  // The client ended the connection; a cancelled turn has nothing left to answer.
  turn = null;
});

/** One prompt turn, streamed with a pause between notifications. */
async function runTurn(id, sessionId, prompt) {
  const token = { cancelled: false, released: null };
  turn = token;
  try {
    if (PROMPT_AUTH) {
      // **Issue #2's exact wire shape, and the reason this knob exists at all.** Measured 2026-10-02
      // against `opencode acp` 2.0.19 with no login: the anonymous default model
      // `opencode/fledge-alpha-free` is geo-blocked from Germany (HTTP 403), and opencode reports any
      // provider 403 on `session/prompt` as `-32000 "Authentication required: provider authentication
      // required"` — the same class and the same code as the login trap this script's `KU_STANDIN_AUTH`
      // produces at `session/load`. Nothing on the wire distinguishes them except that one has a prompt
      // behind it, which is what `failureKind`'s `promptSent` reads.
      //
      // **Nothing streams first.** The measured turn carries no `stopReason` and no text at all, and a
      // fixture that echoed the prompt or wrote a thought before refusing would make the window look as
      // though the agent had started answering — which is the state a screenshot of this dialog must not
      // be taken in.
      process.stderr.write('stand-in: the provider refused the turn\n');
      return replyError(id, -32_000, 'Authentication required: provider authentication required');
    }
    if (ECHO) {
      // Real agents echo the prompt back as `user_message_chunk`, and kurier drops its own echo: the
      // surface draws the prompt the instant Send is pressed. Echoing here keeps that path exercised.
      const first = Array.isArray(prompt) ? prompt[0] : undefined;
      notify(sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: first ?? { type: 'text', text: '' },
      });
    }

    const script = [...OPENING, ...ANSWER.slice(0, Math.max(1, CHUNKS)).map((text) => ({ text }))];
    for (const [index, step] of script.entries()) {
      await pause(DELAY_MS);
      if (token.cancelled) break;
      if (EXIT_MID_TURN && index === 2) {
        // One last useful thing on stderr, the way a real agent gives one, and then vanish without
        // answering the request. The transport's EOF is the whole event: kurier has no stop reason to
        // report and must not invent one.
        process.stderr.write('stand-in: leaving mid-turn\n');
        await flushStdout();
        process.exit(3);
      }
      notify(sessionId, updateFor(step));
    }

    if (PERMISSION && !token.cancelled) {
      // **Mid-turn, after some work has streamed, and before the answer.** Where the question lands in
      // the turn is the part that matters: a dialog over an empty transcript is a different screen
      // from one over a half-finished answer, and the second is the one a person meets. The turn is
      // genuinely open while this waits — the `end_turn` below has not been sent — so a Stop pressed
      // with the dialog up is a real cancellation of a real turn, not a staged imitation of one.
      const answer = await askPermission(sessionId);
      process.stderr.write(`stand-in: permission answered with ${JSON.stringify(answer?.outcome ?? null)}\n`);
    }

    if (HANG && !token.cancelled) {
      // Never answer on our own. The turn stays open until `session/cancel` ends it, which is what makes
      // Stop and a screenshot of a running turn reachable without racing a model.
      await new Promise((resolve) => {
        token.released = resolve;
      });
    }

    if (USAGE && !token.cancelled) {
      // **A cost with the float an agent really sends.** `0.0014555100000000001` is not a typo: it is
      // what a double looks like after a division, and it is the value kurier's transcript used to
      // print verbatim. Sending it here is what makes the rounded line photographable rather than
      // asserted.
      notify(sessionId, {
        sessionUpdate: 'usage_update',
        inputTokens: 1204,
        outputTokens: 268,
        cost: { amount: 0.0014555100000000001, currency: 'USD' },
      });
    }

    // `cancelled` when this script was told to stop, `end_turn` otherwise — the two answers the schema
    // defines, and the difference kurier's state machine reads to decide `stopped` from `idle`.
    reply(id, { stopReason: token.cancelled ? 'cancelled' : 'end_turn' });
  } finally {
    turn = null;
  }
}

/** One scripted step into one `session/update` payload. */
function updateFor(step) {
  if (step.thought) {
    return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } };
  }
  if (step.tool) {
    return {
      sessionUpdate: 'tool_call',
      toolCallId: TOOL_CALL_ID,
      title: step.tool,
      kind: 'read',
      status: step.status,
    };
  }
  if (step.toolUpdate) {
    return { sessionUpdate: 'tool_call_update', toolCallId: TOOL_CALL_ID, status: step.status };
  }
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } };
}

/**
 * The three options this script offers: a model, a thought level, a mode.
 *
 * **The measured three, because a fixture that offered one option would leave the row's hard cases
 * untested.** `KU_STANDIN_CONFIG_MODELS` sets how many models the list holds: 3 keeps a screenshot
 * readable, and 400 is the size `opencode acp` 2.0.19 actually reports and the one the dropdown's
 * search field exists for.
 */
function buildConfigOptions() {
  const models = Array.from({ length: Math.max(1, CONFIG_MODELS) }, (_, index) => ({
    value: `openrouter/vendor/model-${String(index).padStart(3, '0')}`,
    name: `model-${String(index).padStart(3, '0')}`,
  }));
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'Which model answers the next prompt',
      type: 'select',
      category: 'model',
      currentValue: models[0].value,
      options: models,
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

/** `session/new` and the reopen calls answer with the session's configuration, as opencode does. */
function sessionState(sessionId) {
  return {
    sessionId,
    modes: { currentModeId: modeId(), availableModes: modes() },
    configOptions: configOptions,
  };
}

function modes() {
  return [
    { id: 'build', name: 'Build', description: 'Make the change' },
    { id: 'plan', name: 'Plan', description: 'Propose before changing' },
  ];
}

/** The current mode, read out of the option list so the two doors cannot drift. */
function modeId() {
  const mode = (configOptions ?? []).find((option) => option.id === 'mode');
  return mode ? mode.currentValue : 'build';
}

/**
 * `session/set_config_option`: rewrite one option's `currentValue` and answer with the **full** list.
 *
 * **The full list, and that is the whole point of the case.** The schema's answer carries every option,
 * and `core/config-row.ts` takes it as the truth rather than keeping the local guess. The bare
 * `configOptions: []` this used to answer would have emptied the row on every pick — a real state
 * ("this agent has no configuration") dressed up as the answer to a successful set, and exactly the
 * kind of fixture that makes a surface look like it works.
 *
 * **Three refusals, all of them real behaviours an agent has:**
 *
 * - `KU_STANDIN_CONFIG_REFUSE=1` answers an error for every set, which is the state that is otherwise
 *   unreachable against a real agent and the one the "a refusal does not move the row" rule is about;
 * - an unknown `configId` or a value outside the option's list is an error, as `opencode` 2.0.19 does;
 * - a non-string value is refused, because `opencode` implements no boolean options — which is why
 *   kurier does not announce the capability (see `KURIER_CLIENT_CAPABILITIES`).
 */
function setConfigOption(sessionId, params, id) {
  if (CONFIG_REFUSE) {
    return replyError(id, -326_02, `this agent refuses every configuration change: ${params.configId}`);
  }
  const configId = String(params.configId ?? '');
  const value = params.value;
  if (typeof value !== 'string') {
    return replyError(id, -326_02, 'this agent takes a value id, not a tagged value');
  }
  if (configOptions === null) configOptions = buildConfigOptions();
  const index = configOptions.findIndex((option) => option.id === configId);
  if (index === -1) return replyError(id, -326_02, `no such config option: ${configId}`);
  const option = configOptions[index];
  if (option.type === 'select' && !option.options.some((entry) => entry.value === value)) {
    return replyError(id, -326_02, `that value is not one of the offered ones: ${value}`);
  }
  configOptions = [
    ...configOptions.slice(0, index),
    { ...option, currentValue: value },
    ...configOptions.slice(index + 1),
  ];
  reply(id, { configOptions });
  // The push is the same split the real agent makes: opencode announces a *model* change with a
  // `config_option_update` and answers the rest with the list. `KU_STANDIN_CONFIG_PUSH=0` turns it off,
  // so a surface that only listened for the answer and one that only listened for the notification can
  // both be exercised — the row must work either way, because which one an agent sends is not ours to
  // choose.
  if (CONFIG_PUSH && configId === 'model') {
    notify(sessionId, { sessionUpdate: 'config_option_update', configOptions });
  }
}

/** `session/set_mode`: move the mode and answer with the full list, as `opencode` does. */
function setMode(sessionId, mode, id) {
  if (CONFIG_REFUSE) {
    return replyError(id, -326_02, `this agent refuses every configuration change: ${mode}`);
  }
  if (!modes().some((available) => available.id === mode)) {
    return replyError(id, -326_02, `no such mode: ${mode}`);
  }
  if (configOptions === null) configOptions = buildConfigOptions();
  configOptions = configOptions.map((option) =>
    option.id === 'mode' ? { ...option, currentValue: mode } : option,
  );
  reply(id, { configOptions });
  // `current_mode_update`, not `config_option_update`: the schema has a door for exactly this, and a
  // fixture that used the other one would never exercise the narrow arm of `applyConfigUpdate`.
  notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
}

function cancelTurn() {
  if (!turn || turn.cancelled) return;
  turn.cancelled = true;
  if (turn.released) turn.released();
}

function notify(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function reply(id, result) {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Wait until everything written to stdout has left. `process.exit` does not do that for us. */
function flushStdout() {
  return new Promise((resolve) => {
    process.stdout.write('', () => resolve());
  });
}

function pause(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function number(key, fallback) {
  const raw = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(raw) ? raw : fallback;
}

function flag(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}
