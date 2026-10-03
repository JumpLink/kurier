/**
 * Starting an agent from inside a Flatpak.
 *
 * **The problem this file exists for.** A coding agent is a *host* program: `opencode` lives in the
 * person's own `~/.opencode/bin`, keeps its credentials and its model config there, and edits the
 * files in the project you are looking at. Inside a Flatpak, `node:child_process` starts a process
 * in the *sandbox*, where none of that exists — so kurier as shipped could not start the one thing
 * it exists to start. The two finish-args in the manifest are what make the crossing possible, and
 * both are honest costs rather than conveniences:
 *
 * - `--talk-name=org.freedesktop.Flatpak` is the session-bus name `flatpak-spawn --host` answers on.
 *   Without it every call below fails with a permission error.
 * - `--filesystem=host` is what the host process then runs against. An app whose whole job is
 *   running a program that edits your files, granted your whole filesystem, is close to no
 *   filesystem sandbox at all — **this manifest is an installer, not isolation**, and any Flathub
 *   reviewer has to be told that rather than left to infer it.
 *
 * kurier's own permission gate still stands, but it governs the *ACP channel*, not the agent process
 * once it is on the host. That is a real limit of the design, not a bug to be papered over.
 *
 * **Everything here is pure.** `isSandboxed` and `toHostCommand` take their one fact as an argument
 * and read no global state, so a test can say "sandboxed" and get the exact argv back. The one impure
 * call lives in `currentSandboxFacts`, on its own, so the boundary is a name you can grep for.
 *
 * **The program name is passed as argv, never spliced into a string.** Every shell fragment below is
 * a fixed string chosen at author time; the person's program and its arguments arrive as `$0`/`$@`.
 * An agent id or a path containing a space, a quote or a `$(...)` therefore cannot become shell
 * syntax. This is the same reason `Gio.Subprocess` wants an argv array.
 */

import { existsSync } from 'node:fs';

import type { AgentCommand } from './stdio.ts';

/** The program that crosses the sandbox boundary. Fixed: it is the only one flatpak ships. */
export const FLATPAK_SPAWN = 'flatpak-spawn';

/**
 * What "am I sandboxed" is decided from — as a VALUE, not as a question.
 *
 * The fact is a value so this stays testable: a test hands over `true` and gets the sandboxed answer
 * without needing a Flatpak. It is deliberately the *only* input — see `isSandboxed` for why the
 * environment is not one of them.
 */
export interface SandboxFacts {
  /** Whether `/.flatpak-info` is there. */
  readonly flatpakInfoExists: boolean;
}

/**
 * The real facts, read once. **The only impure function in this file.**
 *
 * `existsSync` on a missing path is a single `stat` that fails, so this is cheap enough to call per
 * spawn; the result is deliberately not cached across the process, because a test that fakes an
 * environment has to be able to change the answer.
 */
export function currentSandboxFacts(): SandboxFacts {
  return { flatpakInfoExists: existsSync('/.flatpak-info') };
}

/**
 * Is kurier inside a Flatpak?
 *
 * **`/.flatpak-info` and nothing else.** The file is written by the sandbox into its own root, so it
 * exists exactly when this process is sandboxed. `FLATPAK_ID` is deliberately NOT consulted, because
 * it is not the same question: a terminal, an editor or an IDE installed *as a Flatpak* runs with
 * `FLATPAK_ID` set in an environment that is otherwise the host's, and treating that as sandboxed
 * would send its agents through `flatpak-spawn --host` — a round trip that buys nothing and, for an
 * app that already has the host's PATH, actively loses it. The cost of this choice is the reverse
 * case: a hand-rolled sandbox that sets the variable without the file is treated as a desktop
 * install, and its agent fails to be found. That is the cheap direction to be wrong in, and there is
 * no configuration in which kurier is running under such a sandbox today.
 *
 * Outside a Flatpak the fact is false and every command passes through untouched — see
 * `toHostCommand`.
 */
export function isSandboxed(facts: SandboxFacts): boolean {
  return facts.flatpakInfoExists;
}

/**
 * The outer wrapper. Runs in `/bin/sh` — POSIX, always present, and the only shell flatpak's runtime
 * is guaranteed to have — and it does three jobs before the person's own shell is involved at all.
 *
 * **1. It fences the protocol pipes off (the reason this layer exists twice over).** kurier talks to
 * the agent over stdio, so the child's fd 0 and fd 1 ARE the JSON-RPC channel. Everything that runs
 * before the agent is started inherits them, and a login shell reads four or five files first:
 * `/etc/profile`, `~/.profile`, `.zshenv`, `.zprofile`, `.zlogin`, `.zshrc`. Any of those may print a
 * banner, an update notice or an MOTD — and then the client reads that as a malformed JSON-RPC frame.
 * Worse, any of them may *read* stdin: an `ssh-add` agent prompt, a `read` in a hook, a passphrase
 * question. It would consume the `initialize` request and the handshake would hang with no error at
 * all, which is the worst possible failure: silence that looks like a slow agent.
 *
 * So the two protocol descriptors are parked on high-numbered fds, which a person's rc has no
 * reason to touch, and the inherited stdin/stdout are pointed somewhere harmless — `/dev/null` and
 * stderr, where output is still visible in `kurier`'s log rather than on the wire:
 *
 * ```
 * exec 3<&0 4>&1 0</dev/null 1>&2
 * ```
 *
 * The inner script restores them (`0<&3 1>&4`) immediately before the agent starts, and closes them
 * so the agent inherits exactly three descriptors and nothing else. Measured, with a fake HOME whose
 * profile and rc both print to stdout and `read` from stdin: before this, the profile's output
 * appeared on the protocol stream and the program received an empty stdin; after it, stdout is
 * byte-for-byte the program's own output and the program receives what kurier sent.
 *
 * **2. It picks the shell, and only zsh and bash are trusted with a config file.** The inner script
 * below is POSIX `sh`, so it must run under `sh`; but a PATH that only exists in an *interactive* rc
 * has to be read by the shell that owns that rc, and `.zshrc` is zsh syntax that dash cannot parse.
 * So the rc is sourced in one short-lived child, purely to have it mutate `PATH`, and the inner
 * script then runs in a fresh `sh` that inherits the exported result.
 *
 * The `-i` on that sourcing child is not decoration. Measured, with a fake HOME holding an
 * Ubuntu-style guard:
 *
 * ```
 * /usr/bin/bash -lc '. ~/.bashrc; …'      → rc did NOT run (the guard's own comment says why:
 *                                            "If not running interactively, don't do anything")
 * /usr/bin/bash -i  -c '. ~/.bashrc; …'    → rc ran
 * ```
 *
 * **`-i` prints a job-control complaint when there is no tty** ("cannot set terminal process group"),
 * and it is swallowed here on purpose: it is noise from a helper whose only output we want is the
 * PATH it exported.
 *
 * **The known limit is bash, and it is a limit rather than a bug.** `~/.bashrc` is sourced with
 * interactive semantics, which is the most a non-terminal child can do — and a bash rc that *begins*
 * with the stock Debian/Ubuntu guard behaves differently depending on how that guard is written: one
 * that tests `$-` for `i` passes under `-i`, while one that tests whether stdin is a tty (`[ -t 0 ]`)
 * returns early no matter what, because there is no tty here and there never will be. So a person
 * whose agent PATH is set below such a guard gets the login PATH instead, and `kurier agents` says
 * NOT FOUND. The answer stays honest rather than becoming a guess, and the fix belongs on the
 * machine: put the PATH in `~/.profile` or `~/.bash_profile`, which a login shell reads without
 * either guard. This is measured and stated, not asserted.
 *
 * **3. An unrecognised `$SHELL` gets the login PATH and nothing more.** fish, nushell and csh are not
 * POSIX, so neither the inner script nor a borrowed rc is theirs to run; their login configuration is
 * left alone and kurier starts with whatever `/etc/profile` and `~/.profile` gave `/bin/sh -l`. That
 * is a real, narrower answer rather than a wrong one, and the same is true when `$SHELL` is unset
 * entirely — the fallback is `/bin/sh`, and `PATH` then comes only from the login files, which is
 * enough for an agent installed in a system-wide directory and not enough for one in `~/.local/bin`.
 */
const HOST_OUTER = [
  'exec 3<&0 4>&1 0</dev/null 1>&2',
  '__k_sh="${SHELL:-/bin/sh}"',
  'case "${__k_sh##*/}" in',
  '  zsh|bash)',
  '    __k_rcp="$HOME/.${__k_sh##*/}rc"',
  '    if [ -r "$__k_rcp" ]; then',
  // The rc is sourced in a CHILD, so the PATH it exported is gone when that child exits — measured,
  // and the reason this captures the value rather than just dot-sourcing in place. `tail -n 1`
  // because the rc is a person and a person may print: the value taken is whatever came out last,
  // and by construction the `printf` is the last thing the child does. Without the `tail` a chatty
  // rc puts its banner at the FRONT of the capture and the `case` below then rejects the whole
  // thing. The rc path travels in `KURIER_RC` and not as a positional parameter, because those slots
  // are already taken — the inner script is this shell's `$0` and the program is `$1`.
  '      __k_path=$(KURIER_RC="$__k_rcp" "$__k_sh" -i -c \'. "$KURIER_RC" >/dev/null 2>&1; printf %s "$PATH"\' 2>/dev/null | tail -n 1)',
  // Accept only a value that is non-empty AND contains a `/` — i.e. at least one path-shaped entry.
  // Measured: a "is every character `:` or `/`" test rejects a perfectly good PATH, because an entry
  // like `/home/pascal/.local/bin` is mostly letters. A rejected capture leaves the login PATH in
  // place, which is the honest floor rather than a corrupt one.
  '      case "$__k_path" in',
  '        */*) PATH="$__k_path" ;;',
  '      esac',
  '    fi',
  '    exec /bin/sh -l -c "$0" "$@"',
  '    ;;',
  '  *) exec /bin/sh -l -c "$0" "$@" ;;',
  'esac',
].join('\n');

/**
 * The inner script: POSIX `sh`, run after the rc has been sourced and the pipes fenced.
 *
 * `exec 0<&3 1>&4 3<&- 4>&-` hands the protocol pipes back to the agent and closes the parking fds,
 * so the agent runs with stdin, stdout and stderr and nothing else. It comes FIRST, before the work,
 * so nothing between here and the agent can touch the wire either.
 *
 * `exec -- "$0" "$@"` rather than `exec "$0" "$@"`: the `--` is what makes a program whose name starts
 * with a dash impossible to mistake for an option, and all three of sh, bash and zsh accept it
 * (measured).
 */
const HOST_INNER_PRELUDE = 'exec 0<&3 1>&4 3<&- 4>&-\nexec -- "$0" "$@"';

/** Run the program. */
const HOST_EXEC = HOST_INNER_PRELUDE;

/**
 * Ask the host where the program is.
 *
 * `command -v -- "$0"` and not a PATH walk, because the host's PATH is a different PATH from the
 * sandbox's and is the only one that can answer honestly. The `--` matches the `exec` above; without
 * it a program called `-x` would be read as an option to `command`.
 */
const HOST_PROBE = 'exec 0<&3 1>&4 3<&- 4>&-\ncommand -v -- "$0"';

/** `--env=K=V` tokens for `flatpak-spawn`. One argv entry each; no shell ever sees these. */
/** The inner script of a host question about the directory: what `pwd` says in the host's login shell. */
const HOST_CWD = 'exec 0<&3 1>&4 3<&- 4>&-\npwd';

function envArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => `--env=${key}=${value}`);
}

/**
 * The outer wrapper every host call shares: `--host`, the optional directory and environment, then
 * `/bin/sh -c <outer> <inner> <argv…>`.
 *
 * `<inner>` lands as the outer shell's `$0`, which is how a POSIX `sh -c 'script' name args…` passes
 * the program: `$0` is the program and `$@` its arguments, and the wrapper forwards both unchanged.
 */
function hostArgv(inner: string, argv: readonly string[], command?: AgentCommand): string[] {
  return [
    '--host',
    ...(command?.cwd ? [`--directory=${command.cwd}`] : []),
    ...envArgs(command?.env),
    '/bin/sh',
    '-c',
    HOST_OUTER,
    inner,
    ...argv,
  ];
}

/**
 * The command that starts `command`'s program **on the host**, or `command` itself when kurier is
 * not sandboxed.
 *
 * The passthrough is the common case and is not an optimisation: a desktop install must behave
 * exactly as it did before this file existed, and the only way to be sure of that is to return the
 * very same object it was handed.
 *
 * `cwd` and `env` move *into* the argv (`--directory=`, `--env=`) and are dropped from the returned
 * command, because they are now properties of the HOST process: the sandbox-side `flatpak-spawn` has
 * no business being placed in the agent's working directory, and passing them to `spawn` as well
 * would do exactly that and fail with ENOENT on a path that only exists on the host. The sandbox's
 * own environment is deliberately not forwarded either — it is full of sandbox-only variables, and
 * the host supplies the environment the person expects.
 *
 * ## How the host process is actually ended — measured, and not what the argv suggests
 *
 * The argv looks like one `exec` chain, and it is tempting to conclude that signalling the child
 * kurier spawned signals the agent. **It does not: the pid kurier holds is the sandbox-side
 * `flatpak-spawn`, and the agent is a different process on the other side of the bus.** Every claim
 * below was measured on this machine, inside a GNOME 50 Flatpak, by starting a host process through
 * `flatpak-spawn --host` and then signalling the carrier from inside the sandbox:
 *
 * ```
 * process tree of the agent      opencode  ←  flatpak-session-helper  ←  systemd --user
 *                                 (not a child of flatpak-spawn, and not in kurier's process group)
 *
 * SIGTERM → flatpak-spawn        carrier dies, and the host process ends with it   (forwarded)
 * SIGKILL → flatpak-spawn        carrier dies, and the host process SURVIVES        (orphaned)
 * flatpak kill eu.jumplink.Kurier  no `opencode acp` left on the host
 * ```
 *
 * So: **SIGTERM is forwarded** and does the real work, which is why Stop and a closed window leave
 * nothing behind — verified with a live `opencode acp` turn, gone after `flatpak kill`. **SIGKILL is
 * the sharp edge**: it cannot be forwarded, because a process that cannot be caught cannot forward
 * anything, and the host process is then left running. kurier's `terminate()` escalates to SIGKILL
 * after `killGraceMs`, so an agent that ignores SIGTERM is the case where the escalation can orphan
 * a host process. That is a property of crossing the sandbox, not of kurier — but it is a claim
 * about a process kurier does not own, so it is written down here rather than assumed, and it is
 * the reason `killGraceMs` defaults to a real 2 s rather than 0.
 */
export function toHostCommand(command: AgentCommand, facts: SandboxFacts): AgentCommand {
  // A bundled agent lives in `/app/extra`, which the host cannot see, and runs where kurier runs.
  if (!isSandboxed(facts) || command.bundled) return command;
  return {
    id: command.id,
    title: command.title,
    program: FLATPAK_SPAWN,
    args: hostArgv(HOST_EXEC, [command.program, ...command.args], command),
  };
}

/**
 * The argv that asks the host's shell to resolve `program`, or `null` when kurier is not sandboxed.
 *
 * `null` and not an empty array, so the caller can tell "there is nothing to ask" from "the answer
 * was nothing" — the difference between a PATH walk that already succeeded and a host that does not
 * have the program.
 */
export function hostProbeArgv(program: string, facts: SandboxFacts): string[] | null {
  if (!isSandboxed(facts)) return null;
  return hostArgv(HOST_PROBE, [program]);
}

/**
 * The argv that asks the host where its shell is — `flatpak-spawn --host` starts it in the directory
 * kurier was launched from when the host can see it, else in the host's home. `null` when kurier is not
 * sandboxed, for the same reason `hostProbeArgv` answers `null`: there is nothing to ask.
 */
export function hostCwdArgv(facts: SandboxFacts): string[] | null {
  if (!isSandboxed(facts)) return null;
  return hostArgv(HOST_CWD, []);
}
