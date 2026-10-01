/**
 * A child process as an ACP `Transport`.
 *
 * **The specifier in the imports below is the whole point of this file's existence.**
 *
 * In a gjsify project you import `node:child_process` — *not* `@gjsify/child_process`. Measured
 * twice, and both failures were the same error wearing two costumes: under Node,
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME: gi:`, because the gjsify package resolves to a `gi://` module;
 * under GJS, `Module not found`, because the package is not there at all. The bundler is the
 * resolution path — `gjsify build` then `gjsify run` — and a **module** specifier is what it
 * resolves.
 *
 * This is *not* a gjsify bug. `@gjsify/child_process` carries `runtimes.node: "none"`, because
 * there is nothing to port under Node; and its `test.node.mjs` (48 KB) is a parity suite against
 * the real `node:child_process`, not a Node port. Writing `@gjsify/child_process` here would
 * *look* like using the project's own runtime library and would break the Node half of the test run.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import { channelTransport, type RawChannel, type Transport } from '@kurier/acp/transport';

import {
  currentSandboxFacts,
  FLATPAK_SPAWN,
  hostProbeArgv,
  toHostCommand,
  type SandboxFacts,
} from './sandbox.ts';

/** How an agent process is started. A launcher is a *program*, not a permission. */
export interface AgentCommand {
  /** The adapter id, e.g. `opencode`. What a session record stores as `agent`. */
  readonly id: string;
  /** What a human sees in `kurier agents`. */
  readonly title: string;
  /** The binary, resolved on PATH. */
  readonly program: string;
  readonly args: string[];
  /**
   * The working directory the *process* starts in. This is not the session's scope: that goes in
   * `session/new`'s `cwd` and is stored in the session record. Kept separate because the two mean
   * different things and conflating them is how an agent ends up able to read a directory nobody
   * meant to offer it.
   */
  readonly cwd?: string;
  /**
   * Extra environment for the agent. Never credentials — kurier has nowhere safe to put them in
   * Scheibe 1, and a token in here would land in a session record's process listing.
   */
  readonly env?: Record<string, string>;
}

export interface StdioChannelOptions {
  command: AgentCommand;
  /** Lines the agent writes to stderr. ACP says stderr is for logs; kurier never parses it. */
  /** One line at a time, from the agent's stderr. Delivered, never interpreted. */
  onStderr?: (line: string) => void;
  /** How long the process gets between `SIGTERM` and `SIGKILL`. */
  killGraceMs?: number;
  /**
   * The sandbox facts to decide with. Defaults to the real ones; a test injects them so the
   * sandboxed path can be exercised on a machine that is not a Flatpak. It is a seam for exactly
   * one decision — `toHostCommand` — and it cannot make the spawn itself succeed, because
   * `flatpak-spawn` only exists inside a Flatpak.
   */
  sandboxFacts?: SandboxFacts;
}

const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * How long the "is it installed" host probe may take. Short, because the probe sits on the path of
 * `kurier agents` and of any window that reports launcher state: a slow answer reads as a broken
 * app, and nothing about resolving one program's location is worth more than this.
 */
const HOST_PROBE_TIMEOUT_MS = 5000;

/**
 * The command to hand to `spawn`, which is NOT always the command that was asked for.
 *
 * This exists as its own function because the one thing that is easy to get wrong here is
 * invisible from the outside: **`cwd` and `env` must be read off the REWRITTEN command.** The rewrite
 * folds them into the `flatpak-spawn` argv as `--directory=`/`--env=` — they are properties of the
 * HOST process — and drops them from the result. So on a desktop install they are the same values as
 * before, and on a Flatpak they are absent, and that is exactly the point. Reading them off the
 * ORIGINAL command instead puts `flatpak-spawn` itself into a directory that only exists on the host,
 * and the spawn dies with ENOENT before it ever crosses.
 *
 * A separate export so a test can assert that decision without a Flatpak: `flatpak-spawn` exists only
 * inside one, so the spawn itself cannot be made to succeed on a build host.
 */
export function resolveSpawnCommand(
  command: AgentCommand,
  facts: SandboxFacts = currentSandboxFacts(),
): AgentCommand {
  return toHostCommand(command, facts);
}

export class StdioChannel implements RawChannel {
  readonly command: AgentCommand;
  #child: ChildProcessWithoutNullStreams;
  #dataListeners = new Set<(data: string) => void>();
  #endListeners = new Set<(reason: Error | undefined) => void>();
  #stderrBuffer = '';
  #closed = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  #killGraceMs: number;
  /** The child has been reaped and `#exitReason` is the answer. */
  #hasExited = false;
  #exitReason: Error | undefined = undefined;
  /** stdout has reached EOF (or been torn down), so no further chunk can arrive. */
  #isStdoutDone = false;

  constructor(options: StdioChannelOptions) {
    const { program } = options.command;
    // The AGENT's command, not the one that will be spawned: an error message has to name
    // `opencode`, never the `flatpak-spawn` that happens to be carrying it. See sandbox.ts.
    this.command = options.command;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const actual = resolveSpawnCommand(options.command, options.sandboxFacts ?? currentSandboxFacts());
    const { cwd, env } = actual;
    this.#child = spawn(actual.program, actual.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      // A chunk boundary is not a message boundary. The `MessageReader` in @kurier/acp owns that
      // decision; this layer only moves bytes and never looks inside a line.
      for (const listener of this.#dataListeners) listener(chunk);
    });
    // The channel's end is gated on stdout EOF, not on the process's exit — see `#maybeEnd`.
    // `end` is the complete answer; `close` also covers the other teardown (`destroy()` with an
    // error emits `close` and never `end`), and it is idempotent, so both may fire.
    const onStdoutDone = (): void => {
      this.#isStdoutDone = true;
      this.#maybeEnd();
    };
    this.#child.stdout.on('end', onStdoutDone);
    this.#child.stdout.on('close', onStdoutDone);
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      if (!options.onStderr) return;
      this.#stderrBuffer += chunk;
      this.#flushStderr(options.onStderr);
    });
    this.#child.on('error', (error: Error) => this.#end(error));
    this.#child.on('exit', (code, signal) => {
      // An agent killed mid-write leaves a partial line in the stderr buffer, and that line is
      // usually the most interesting thing it ever said — "failed to load config X" arrives
      // without a newline when the process is told to stop. Flushing it here is why `onStderr` sees
      // it; without this the buffer is dropped on the floor exactly when it matters.
      this.#flushStderr(options.onStderr);
      // exit(code 0) is a clean end; anything else carries a reason the client should surface
      // rather than swallow — a crashed agent and a cancelled one look the same otherwise.
      // `program`, not `actual.program`: a message has to name the agent a person recognises.
      this.#hasExited = true;
      this.#exitReason =
        code === 0
          ? undefined
          : new Error(`${program} exited with code ${code ?? 'none'}${signal ? ` (${signal})` : ''}`);
      // NOT `#end` here: the process being gone is only half of "the agent has finished talking".
      this.#maybeEnd();
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  send(data: string): void {
    if (this.#closed) throw new Error(`${this.command.program} is gone — cannot send`);
    this.#child.stdin.write(`${data}\n`);
  }

  onData(listener: (data: string) => void): void {
    this.#dataListeners.add(listener);
  }

  onEnd(listener: (reason: Error | undefined) => void): void {
    this.#endListeners.add(listener);
  }

  /**
   * End the agent, politely first.
   *
   * `SIGTERM`, then `SIGKILL` after a grace period: an agent mid-turn holds open state, and a bare
   * `SIGKILL` leaves a lock behind in its own data directory that fails the *next* `kurier start`
   * with a message about a lock nobody remembers. The timer is unref'd so it can never be the
   * reason the CLI hangs on exit.
   */
  terminate(): void {
    if (this.#closed) return;
    this.#child.kill('SIGTERM');
    this.#killTimer = setTimeout(() => {
      if (!this.#closed) this.#child.kill('SIGKILL');
    }, this.#killGraceMs);
    (this.#killTimer as { unref?: () => void }).unref?.();
    this.#child.stdin.end();
  }

  /**
   * Hand out every complete line in the stderr buffer, keeping the rest.
   *
   * Split on newlines rather than on a fixed stride: an agent's stderr carries paths, JSON diffs
   * and quoted model output, so a reader that guessed at boundaries would eventually split a line
   * that happened to contain one. This layer moves bytes and never looks inside a line — that
   * decision belongs to whoever reads them, not to the process that produced them.
   */
  #flushStderr(onStderr: ((line: string) => void) | undefined): void {
    if (!onStderr) return;
    let newline: number;
    while ((newline = this.#stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.#stderrBuffer.slice(0, newline);
      this.#stderrBuffer = this.#stderrBuffer.slice(newline + 1);
      if (line.trim()) onStderr(line);
    }
  }

  /**
   * End the channel — but only once BOTH halves of "the agent has finished talking" are in.
   *
   * **Ending on `exit` loses the agent's last words, and the two runtimes lose them differently.**
   * `exit` says the *process* is gone; it says nothing about whether the bytes it already wrote
   * have been read. On GJS `node:child_process` is polyfilled over `Gio.Subprocess`, so stdout
   * arrives through `read_bytes_async` — a GLib main-context source — and the child's `exit`
   * source can be dispatched first. Ending here dropped the final JSON-RPC message, which for a
   * one-turn `kurier start` is the agent's actual answer. On Node `exit` merely *tends* to arrive
   * before the stdio streams are drained, so the same code was a latent bug there too.
   *
   * Node's own answer is the event called `close` (emitted once the process has ended *and* the
   * stdio streams are closed), and that is what this reproduces — but through stdout's own EOF
   * rather than through `close`, because the polyfill emits `close` from its `wait_async` callback
   * immediately after `exit`, with no reference to the streams at all, so listening for it would
   * reproduce the bug rather than fix it.
   *
   * fixed upstream in gjsify: `@gjsify/child_process`'s `spawn` emits `close` back to back with
   * `exit` instead of waiting for the stdout/stderr pipes to end (`src/index.ts`, the
   * `proc.wait_async` callback; `exec`/`execFile` do the same in the `communicate_async` one).
   */
  #maybeEnd(): void {
    if (!this.#hasExited || !this.#isStdoutDone) return;
    this.#end(this.#exitReason);
  }

  #end(reason: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#killTimer) clearTimeout(this.#killTimer);
    for (const listener of this.#endListeners) listener(reason);
    this.#dataListeners.clear();
    this.#endListeners.clear();
  }
}

export function stdioTransport(options: StdioChannelOptions): Transport {
  return channelTransport(new StdioChannel(options));
}

/**
 * Whether a program is on PATH, and where.
 *
 * **Three answers, in order, and the order is the point.** A program named by path is the person's
 * own answer and is only ever checked here. Failing that, the sandbox's own PATH is walked (pure,
 * fast, and right for a desktop install). Only if that finds nothing AND kurier is inside a Flatpak
 * is the host asked, because then the sandbox's PATH is the wrong PATH: the agent is a host program
 * and the host's shell is the only thing that can say where it is. See `sandbox.ts`.
 *
 * The first two steps stay pure in their `env` argument, so a test can still say "/usr/bin has
 * opencode in it" without a subprocess; the third is the one impure step, and it sits behind the
 * injected `facts` argument so a test that does not want it can say so.
 *
 * This is the difference between `kurier agents` reporting "not installed" and reporting "broken",
 * which are two very different messages to somebody reading them at 23:00.
 */
export function which(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  facts = currentSandboxFacts(),
): string | null {
  if (program.includes('/')) return isExecutable(program, env) ? program : null;
  const local = whichOnPath(program, env);
  if (local) return local;
  const probe = hostProbeArgv(program, facts);
  return probe ? probeOnHost(probe) : null;
}

/** The pure PATH walk, exactly as it was. */
function whichOnPath(program: string, env: NodeJS.ProcessEnv): string | null {
  const path = env['PATH'] ?? '';
  // A Windows PATH uses `;`. Checking for it rather than assuming `:` keeps `kurier agents`
  // honest on the platform the app is eventually meant to run on.
  const separator = path.includes(';') ? ';' : ':';
  for (const dir of path.split(separator)) {
    if (!dir) continue;
    const candidate = dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${program}` : `${dir}/${program}`;
    if (isExecutable(candidate, env)) return candidate;
  }
  return null;
}

/**
 * The host's answer, or `null`.
 *
 * `null` for anything but a clean exit: a `flatpak-spawn` that could not reach the bus, a shell that
 * could not read the rc, a program the host does not have. All of them are "not installed" as far
 * as the person reading the table is concerned, and the difference is not worth a subprocess failure
 * on the screen. stdout is trimmed and the LAST line taken, because a login shell that printed a
 * MOTD would otherwise hand back a sentence instead of a path.
 */
function probeOnHost(argv: string[]): string | null {
  // `stdin: 'ignore'` and a bounded `timeout` because this runs on a path a person waits on: a host
  // whose shell hangs — an rc that blocks on a terminal read, a `gpg-agent` prompt, a network mount
  // in a login script — would otherwise hang `kurier agents` and, through it, the window that asks.
  // `stdio` rather than `stdin`: this is `spawnSync`, and there the option that covers all three
  // descriptors is `stdio` — `stdin` is an `spawn` option and the type says so. The probe must not
  // read stdin (a host rc could block on one) and does not write stderr, so 'ignore' on both is the
  // honest answer rather than a leftover. Measured on GJS: `stdio: ['ignore','pipe','pipe']` closes
  // fd 0, and a numeric `timeout` aborts with `ETIMEDOUT` and `status === null`.
  const result = spawnSync(FLATPAK_SPAWN, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: HOST_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  const found = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  // **Only an absolute path counts.** `command -v` also answers for an alias, a function, a keyword
  // and a builtin — and those print their own name, e.g. bare `opencode` for an alias, which is
  // emphatically not something `spawn` can execute. kurier spawns a program, so anything that is not
  // a path is "not installed" as far as this table is concerned.
  return found !== undefined && probeAccepts(found) ? found : null;
}

/**
 * Is this what a probe may report as "installed"?
 *
 * **Only an absolute path.** `command -v` also answers for an alias, a function, a keyword and a
 * builtin, and each of those prints its own NAME — bare `opencode` for an alias, which is not
 * something `spawn` can execute. kurier spawns a *program*, so anything that is not a path is "not
 * installed" as far as this table is concerned; reporting it otherwise would put a name in a
 * `kurier agents` STATE column that would fail the moment somebody acted on it.
 *
 * Exported because it is the whole of the rule, and a rule with no test is a comment.
 */
export function probeAccepts(answer: string): boolean {
  return answer.startsWith('/');
}

function isExecutable(candidate: string, env: NodeJS.ProcessEnv): boolean {
  // `KURIER_TEST_ASSUME_EXECUTABLE=1` skips the mode check so a Windows checkout without Unix
  // execute bits still exercises the PATH walk. It is a test seam, not a way to weaken the real
  // answer: nothing in the CLI sets it.
  const mode = env['KURIER_TEST_ASSUME_EXECUTABLE'] === '1' ? constants.F_OK : constants.X_OK;
  try {
    accessSync(candidate, mode);
    return true;
  } catch {
    return false;
  }
}
