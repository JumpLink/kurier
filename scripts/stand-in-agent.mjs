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
 * | `KU_STANDIN_CHUNKS`        | `5`     | How many `agent_message_chunk`s to stream (the answer's tail).        |
 * | `KU_STANDIN_ECHO`          | `1`     | Echo the prompt as `user_message_chunk`, as every real agent does.     |
 * | `KU_STANDIN_HANG`          | unset   | **Never** end the turn on its own — Stop has something to stop.       |
 * | `KU_STANDIN_EXIT_MID_TURN` | unset   | **Exit the process** partway through, answering nothing.               |
 * | `KU_STANDIN_PERMISSION`    | unset   | **Ask** `session/request_permission` mid-turn, and wait for the answer. |
 *
 * ```sh
 * KURIER_SESSIONS_FILE=<file> KU_APP_SESSION=<id> KU_APP_AGENT=stand-in \
 *   ./node_modules/.bin/gjsify workspace kurier-cli start:app
 * ```
 *
 * Exit code 0 on a normal shutdown, 3 for the deliberate mid-turn exit, so a test can tell them apart.
 */

import { createInterface } from 'node:readline';

const DELAY_MS = number('KU_STANDIN_DELAY_MS', 350);
const CHUNKS = number('KU_STANDIN_CHUNKS', 5);
const HANG = flag('KU_STANDIN_HANG');
const EXIT_MID_TURN = flag('KU_STANDIN_EXIT_MID_TURN');
const PERMISSION = flag('KU_STANDIN_PERMISSION');
const ECHO = flag('KU_STANDIN_ECHO', true);

/** Fixed, so two screenshots are comparable. `session/load` keeps whatever id it was asked for. */
const SESSION_ID = 'ses_standin_0001';
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
    sessionCapabilities: { close: {}, delete: {}, fork: {}, list: {}, resume: {} },
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
 * all four `session/request_permission` kinds, deliberately: the dialog is supposed to show two of
 * them, and a fixture that only offered `allow_once`/`reject_once` would let a dialog that renders
 * `allow_always` pass against a stand-in that never sent one. Every option the real path has to
 * filter, this sends.
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
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow in this session', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Decline', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Always decline in this session', kind: 'reject_always' },
      ],
    },
  });
  return answer;
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
  if (typeof message === 'object' && message !== null && message.method === undefined && message.id !== undefined) {
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
      return reply(id, sessionState(SESSION_ID));
    case 'session/load':
    case 'session/resume':
      // The id the client asked for: kurier prompts the session its store holds, not this script's.
      // No history is replayed — a real agent does, and kurier deliberately does not record that
      // replay; see `AgentSession.#bindAgent`.
      return reply(id, sessionState(String(params.sessionId ?? SESSION_ID)));
    case 'session/set_mode':
    case 'session/set_config_option':
      return reply(id, { configOptions: [] });
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

/** `session/new` and the reopen calls answer with the session's configuration, as opencode does. */
function sessionState(sessionId) {
  return {
    sessionId,
    modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] },
    configOptions: [],
  };
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
