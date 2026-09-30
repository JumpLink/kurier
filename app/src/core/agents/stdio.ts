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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import { channelTransport, type RawChannel, type Transport } from '@kurier/acp/transport';

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
}

const DEFAULT_KILL_GRACE_MS = 2000;

export class StdioChannel implements RawChannel {
  readonly command: AgentCommand;
  #child: ChildProcessWithoutNullStreams;
  #dataListeners = new Set<(data: string) => void>();
  #endListeners = new Set<(reason: Error | undefined) => void>();
  #stderrBuffer = '';
  #closed = false;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  #killGraceMs: number;

  constructor(options: StdioChannelOptions) {
    this.command = options.command;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const { program, args, cwd, env } = options.command;
    this.#child = spawn(program, args, {
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
      this.#end(
        code === 0
          ? undefined
          : new Error(`${program} exited with code ${code ?? 'none'}${signal ? ` (${signal})` : ''}`),
      );
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
 * Pure in its environment argument, so a test can say "`/usr/bin` has opencode in it" without a
 * subprocess and without depending on what happens to be installed. This is the difference
 * between `kurier agents` reporting "not installed" and reporting "broken", which are two very
 * different messages to somebody reading them at 23:00.
 */
export function which(program: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (program.includes('/')) return isExecutable(program, env) ? program : null;
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
