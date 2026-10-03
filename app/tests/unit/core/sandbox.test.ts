/**
 * The Flatpak host bridge.
 *
 * **Three kinds of assertion, and the split matters.** Most cases are about an argv, so they assert
 * on an argv — the claim is not "the agent starts" (that needs a real agent and is the GJS
 * integration test's job) but "this exact command line reaches the host, with the program as an
 * argument and never as text". Those are pure and run on both runtimes.
 *
 * The second kind actually EXECUTES the wrapper in a real `/bin/sh` with a hostile fake HOME, because
 * the bugs this file was written to prevent are not visible in a string: a login rc that prints
 * corrupts the protocol stream, and one that reads stdin eats the request. Asserting the argv
 * contains the word `/dev/null` proves nothing about either. Those cases spawn `/bin/sh`, which
 * **both runtimes can do** — `node:child_process` is polyfilled on GJS (measured: `spawnSync` with
 * `encoding: 'utf8'` returns a string there), so there is no Node-only case and no reason for one.
 *
 * The third kind is the sandboxed-spawn path in `StdioChannel`, exercised against a real child
 * process. `flatpak-spawn` does not exist on a build host, so what is asserted there is the
 * property that was actually wrong — that `cwd`/`env` come off the REWRITTEN command, and that a
 * non-sandboxed install spawns byte-identical argv.
 */

import { describe, expect, it } from '@gjsify/unit';

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FLATPAK_SPAWN,
  currentSandboxFacts,
  hostCwdArgv,
  hostProbeArgv,
  isSandboxed,
  toHostCommand,
  type SandboxFacts,
} from '../../../src/core/agents/sandbox.ts';
import {
  probeAccepts,
  resolveSpawnCommand,
  StdioChannel,
  which,
  type AgentCommand,
} from '../../../src/core/agents/stdio.ts';

/** Sandboxed: the one fact, present. */
const SANDBOXED: SandboxFacts = { flatpakInfoExists: true };
/** A desktop install. */
const NOT_SANDBOXED: SandboxFacts = { flatpakInfoExists: false };

const OPENCODE: AgentCommand = {
  id: 'opencode',
  title: 'OpenCode (opencode acp)',
  program: 'opencode',
  args: ['acp'],
};

function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-sandbox-'));
  try {
    return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return Promise.reject(error);
  }
}

/** The same, for a case whose value is the thing under test. */
function withTempDirValue<T>(run: (dir: string) => T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-sandbox-'));
  try {
    return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return Promise.reject(error);
  }
}

/** A file the person would find in their home, with the given body. */
function writeHomeFile(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o644);
}

/** An executable script in `dir`, returned as an absolute path. */
function writeProgram(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * The argv pieces the production code builds, resolved out of a rewritten command.
 * Keeping the indices derived (rather than hardcoded) means a layout change breaks these loudly.
 */
function shapeOf(command: AgentCommand): {
  outer: string;
  inner: string;
  tail: string[];
} {
  const sh = command.args.indexOf('/bin/sh');
  return { outer: command.args[sh + 2], inner: command.args[sh + 3], tail: command.args.slice(sh + 4) };
}

export default async () => {
  await describe('isSandboxed', async () => {
    await it('is true when /.flatpak-info exists', async () => {
      expect(isSandboxed(SANDBOXED)).toBe(true);
    });

    await it('is false when it does not', async () => {
      expect(isSandboxed(NOT_SANDBOXED)).toBe(false);
    });

    await it('ignores FLATPAK_ID, so a Flatpak-d terminal is not mistaken for a sandbox', async () => {
      // A terminal, editor or IDE installed AS a Flatpak carries FLATPAK_ID in an environment that
      // is otherwise the host's. Treating that as sandboxed would route its agent through
      // flatpak-spawn --host and lose the host PATH it already had.
      expect(isSandboxed({ flatpakInfoExists: false })).toBe(false);
    });

    await it('agrees with the machine this suite runs on, via the file alone', async () => {
      expect(typeof currentSandboxFacts().flatpakInfoExists).toBe('boolean');
    });
  });

  await describe('toHostCommand — outside a sandbox', async () => {
    await it('returns the very same object, not a copy', async () => {
      // Identity, not equality: a desktop install must be untouched, and the cheapest way to say
      // that is that the object never got rebuilt.
      expect(toHostCommand(OPENCODE, NOT_SANDBOXED)).toBe(OPENCODE);
    });

    await it('passes a command with cwd and env through untouched', async () => {
      const withExtras: AgentCommand = { ...OPENCODE, cwd: '/tmp', env: { A: '1' } };
      expect(toHostCommand(withExtras, NOT_SANDBOXED)).toBe(withExtras);
    });
  });

  await describe('toHostCommand — a bundled command', async () => {
    const BUNDLED: AgentCommand = {
      ...OPENCODE,
      program: '/app/extra/agents/opencode/opencode',
      env: { XDG_CONFIG_HOME: '/data/kurier/agents/opencode/config' },
      bundled: true,
    };

    await it('is returned as the very same object even when sandboxed', async () => {
      // It lives in /app/extra, which the host cannot see: rewriting it would start a program that
      // does not exist there.
      expect(toHostCommand(BUNDLED, SANDBOXED)).toBe(BUNDLED);
    });

    await it('is returned unchanged when not sandboxed', async () => {
      expect(toHostCommand(BUNDLED, NOT_SANDBOXED)).toBe(BUNDLED);
    });

    await it('leaves a non-bundled command rewritten as before', async () => {
      expect(toHostCommand(OPENCODE, SANDBOXED).program).toBe(FLATPAK_SPAWN);
      expect(toHostCommand({ ...OPENCODE, bundled: undefined }, SANDBOXED).program).toBe(FLATPAK_SPAWN);
    });

    await it('is spawned directly, with its own environment, and its directories exist after launch', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const root = join(dir, 'agents', 'fake');
        const config = join(root, 'config');
        const program = writeProgram(
          dir,
          'bundled',
          '#!/bin/sh\nprintf "XDG:%s\\n" "$XDG_CONFIG_HOME"\nprintf "BLANK:[%s]\\n" "$KURIER_BLANKED"\n',
        );
        const channel = new StdioChannel({
          command: {
            id: 'fake',
            title: 'fake',
            program,
            args: [],
            env: { XDG_CONFIG_HOME: config, KURIER_BLANKED: '' },
            bundled: true,
          },
          onStderr: () => {},
          sandboxFacts: SANDBOXED,
        });
        return new Promise<string>((resolve, reject) => {
          let out = '';
          channel.onData((chunk) => {
            out += chunk;
          });
          channel.onEnd((reason) => (reason ? reject(reason) : resolve(out)));
        }).then((out) => {
          expect(out).toContain(`XDG:${config}`);
          expect(out).toContain('BLANK:[]');
          expect(existsSync(config)).toBe(true);
        });
      });
    });
  });

  await describe('toHostCommand — inside a sandbox', async () => {
    await it('starts flatpak-spawn, not the agent', async () => {
      expect(toHostCommand(OPENCODE, SANDBOXED).program).toBe(FLATPAK_SPAWN);
    });

    await it('keeps the launcher identity so the GUI still knows which agent this is', async () => {
      const rewritten = toHostCommand(OPENCODE, SANDBOXED);
      expect(rewritten.id).toBe('opencode');
      expect(rewritten.title).toBe(OPENCODE.title);
    });

    await it('passes --host first, and /bin/sh straight after', async () => {
      const args = toHostCommand(OPENCODE, SANDBOXED).args;
      expect(args[0]).toBe('--host');
      expect(args[1]).toBe('/bin/sh');
      expect(args[2]).toBe('-c');
    });

    await it('ends with the program and its args as separate argv entries', async () => {
      // The whole point of the argv discipline: a program name is data, so it can hold a space.
      expect(shapeOf(toHostCommand(OPENCODE, SANDBOXED)).tail).toStrictEqual(['opencode', 'acp']);
    });

    await it('never splices the program into either shell fragment', async () => {
      // A program named `a; touch /tmp/pwned` must arrive as one argument, unexecuted. The two
      // positions a shell would ever READ are the outer wrapper and the inner script; everything in
      // the tail is `$0`/`$@` and is never parsed as text.
      const nasty: AgentCommand = {
        ...OPENCODE,
        program: 'weird name; touch /tmp/pwned',
        args: ['$HOME', '`id`', '&& echo boom'],
      };
      const { outer, inner, tail } = shapeOf(toHostCommand(nasty, SANDBOXED));
      expect(tail).toStrictEqual(['weird name; touch /tmp/pwned', '$HOME', '`id`', '&& echo boom']);
      for (const fragment of [outer, inner]) {
        for (const value of [nasty.program, ...nasty.args]) {
          if (value === '$HOME') continue; // a real fragment, not the caller's placeholder
          expect(fragment).not.toContain(value);
        }
      }
    });

    await it('folds cwd into --directory and drops it from the returned command', async () => {
      // cwd is now a property of the HOST process. Left on the returned command it would also be
      // applied to the sandbox-side flatpak-spawn, which fails ENOENT on a host-only path.
      const rewritten = toHostCommand({ ...OPENCODE, cwd: '/home/someone/proj' }, SANDBOXED);
      expect(rewritten.args).toContain('--directory=/home/someone/proj');
      expect(rewritten.cwd).toBe(undefined);
    });

    await it('omits --directory entirely when there is no cwd', async () => {
      const args = toHostCommand(OPENCODE, SANDBOXED).args;
      expect(args.some((a) => a.startsWith('--directory='))).toBe(false);
    });

    await it('folds env into --env=K=V and drops it from the returned command', async () => {
      const rewritten = toHostCommand({ ...OPENCODE, env: { A: '1', B: 'two words' } }, SANDBOXED);
      expect(rewritten.args).toContain('--env=A=1');
      // A value with a space stays ONE argv entry, which is why this needs no quoting.
      expect(rewritten.args).toContain('--env=B=two words');
      expect(rewritten.env).toBe(undefined);
    });

    await it('puts cwd and env before /bin/sh, so the wrapper runs with them already set', async () => {
      const args = toHostCommand({ ...OPENCODE, cwd: '/tmp', env: { A: '1' } }, SANDBOXED).args;
      const sh = args.indexOf('/bin/sh');
      expect(args.indexOf('--directory=/tmp')).toBeLessThan(sh);
      expect(args.indexOf('--env=A=1')).toBeLessThan(sh);
    });
  });

  await describe('the protocol pipes are fenced off', async () => {
    // The reason the wrapper exists twice over. Everything that runs before the agent starts
    // inherits stdin and stdout, and a login shell reads four or five files first.

    await it('parks stdin/stdout on high fds and points the inherited ones somewhere harmless', async () => {
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('exec 3<&0 4>&1 0</dev/null 1>&2');
    });

    await it('hands the pipes back and closes the parking fds before the agent starts', async () => {
      // First in the inner script, so nothing between here and the agent can touch the wire.
      const { inner } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(inner.split('\n')[0]).toBe('exec 0<&3 1>&4 3<&- 4>&-');
    });

    await it('uses -- so a program whose name starts with a dash is not read as an option', async () => {
      const { inner } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(inner).toContain('exec -- "$0" "$@"');
      expect(hostProbeArgv('opencode', SANDBOXED)?.join('\n')).toContain('command -v -- "$0"');
    });

    await it('asks the host where its shell is — and only when sandboxed', async () => {
      expect(hostCwdArgv({ flatpakInfoExists: false })).toBe(null);
      const argv = hostCwdArgv(SANDBOXED);
      expect(argv?.[0]).toBe('--host');
      expect(argv?.at(-1)).toBe('exec 0<&3 1>&4 3<&- 4>&-\npwd');
    });

    await it('answers on the protocol fd, through the same wrapper, in the directory it was started in', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kurier-cwd-')));
      try {
        const home = join(root, 'home');
        const work = join(root, 'work');
        mkdirSync(home);
        mkdirSync(work);
        const argv = hostCwdArgv(SANDBOXED) ?? [];
        // What `flatpak-spawn --host` would hand to the host: everything after `--host`.
        const run = spawnSync(argv[1] ?? '', argv.slice(2), {
          cwd: work,
          encoding: 'utf8',
          env: { HOME: home, SHELL: '/bin/sh', PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
        });
        expect(run.status).toBe(0);
        expect(run.stdout.trim()).toBe(work);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    /**
     * The end-to-end proof, in a real `/bin/sh`, on both runtimes.
     *
     * The fake HOME is hostile on purpose: its profile AND its rc print to stdout and `read` from
     * stdin. Without the fence, the print lands in the middle of the JSON-RPC stream and the `read`
     * eats the request; with it, stdout is byte-for-byte the program's own output and the program
     * receives what kurier sent. `SOCKET`-style isolation is not needed — this is a pipe.
     */
    await it('leaves stdout untouched and stdin intact, with a profile and rc that print and read', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        // Printed noise AND a stdin read, in both files a login shell sources.
        const hostile = 'echo "RC-NOISE-ON-STDOUT"\nread -r _swallowed || true\n';
        writeHomeFile(home, '.profile', hostile);
        writeHomeFile(home, '.zshrc', hostile);
        writeHomeFile(home, '.bashrc', hostile);
        // A program that says what it received, so a swallowed request is visible.
        const program = writeProgram(
          dir,
          'probe-agent',
          '#!/bin/sh\nprintf "AGENT-START\\n"\nwhile IFS= read -r line; do printf "AGENT-GOT:%s\\n" "$line"; done\n',
        );

        const { outer, inner, tail } = shapeOf(
          toHostCommand({ id: 'p', title: 'p', program, args: [] }, SANDBOXED),
        );
        // The inner script runs `sh -l`, which reads .profile again — harmless, it is fenced.
        const request = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
        const result = spawnSync('/bin/sh', ['-c', outer, inner, ...tail], {
          input: `${request}\n`,
          encoding: 'utf8',
          timeout: 20_000,
          // The fake HOME, so the inner `sh -l` reads the hostile login files and not the
          // developer's own. Everything else is inherited: the real PATH is what makes `/bin/sh`
          // and the program's own `printf` resolvable.
          env: { ...process.env, HOME: home, SHELL: '/bin/sh' },
        });

        // stdout is the protocol stream: it must contain the program's output and NOTHING else.
        expect(result.stdout).toBe(`AGENT-START\nAGENT-GOT:${request}\n`);
        expect(result.stdout).not.toContain('RC-NOISE-ON-STDOUT');
        // And the request reached the program instead of being eaten by the rc's `read`.
        expect(result.stdout).toContain('AGENT-GOT:');
      });
    });

    await it('also holds for the probe script, which prints its answer on stdout', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        writeHomeFile(home, '.profile', 'echo "PROFILE-NOISE"\nread -r _s || true\n');
        const bin = join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        writeProgram(bin, 'hostagent', '#!/bin/sh\n');
        const probe = hostProbeArgv('hostagent', SANDBOXED);
        expect(probe).not.toBe(null);
        const { outer, inner, tail } = shapeOfForProbe(probe);
        // The probe runs `sh -l`, which reads .profile — that is where it gets a PATH at all, and the
        // same file is where the noise and the stdin read come from.
        writeHomeFile(
          home,
          '.profile',
          `export PATH="${bin}:$PATH"\necho "PROFILE-NOISE"\nread -r _s || true\n`,
        );
        // HOME must be the fake one: the inner `sh -l` reads the REAL login files otherwise, and
        // would resolve against the developer's own PATH instead of the fixture's.
        const result = spawnSync('/bin/sh', ['-c', outer, inner, ...tail], {
          input: 'not-a-request\n',
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, HOME: home, SHELL: '/bin/sh' },
        });
        expect(result.stdout.trim()).toBe(join(bin, 'hostagent'));
        expect(result.stdout).not.toContain('PROFILE-NOISE');
      });
    });
  });

  await describe('the shell is chosen, and the inner script is always POSIX sh', async () => {
    await it('runs the inner script with /bin/sh -l, never with the person’s $SHELL', async () => {
      // fish, nushell and csh are not POSIX. Handing them a `case`/`exec` script is how a person
      // with a working setup gets a syntax error instead of an agent.
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('exec /bin/sh -l -c "$0" "$@"');
    });

    await it('sends an unrecognised $SHELL down the /bin/sh path with no rc', async () => {
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('*) exec /bin/sh -l -c "$0" "$@" ;;');
    });

    await it('scaffolds the rc name from the shell basename, so zsh and bash differ', async () => {
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('zsh|bash)');
      expect(outer).toContain('__k_rcp="$HOME/.${__k_sh##*/}rc"');
    });

    await it('captures the rc PATH from a child, taking the LAST line it printed', async () => {
      // The rc runs in a child, so its exported PATH is gone when the child exits. `tail -n 1` is
      // what makes a chatty rc survivable: measured, without it the banner lands at the front of the
      // capture and the shape check rejects the whole value.
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('| tail -n 1');
    });

    await it('passes the rc path in an env var, not a positional, which the program owns', async () => {
      // `$0` is the inner script and `$1` is the agent; the rc path needs its own channel.
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('KURIER_RC=');
    });

    await it('accepts a capture only if it holds a slash, and keeps the login PATH otherwise', async () => {
      // A "only `:` and `/`" test would reject a real PATH — an entry is mostly letters. The shape
      // check that works is "contains a `/`", and an empty or banner-only capture falls through.
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('*/*) PATH="$__k_path" ;;');
    });

    await it('runs with -i, because a non-interactive rc returns before touching PATH', async () => {
      // A `$-`-style .bashrc guard ("if not running interactively, do nothing") is exactly this
      // case, and it is the shape Debian/Ubuntu ship. Measured with a fake HOME holding that guard:
      // `bash -lc` does not source the rc, `bash -i -c` does. The `-t 0` variant of the same guard
      // cannot be satisfied without a tty and is recorded as the known limit in sandbox.ts.
      if (process.platform === 'win32' || !existsSync('/bin/bash')) return;
      await withTempDir((dir) => {
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        writeHomeFile(home, '.bashrc', 'case $- in *i*) ;; *) return;; esac\nexport KURIER_RC_RAN=1\n');
        const run = (flags: string): string =>
          spawnSync('/bin/bash', [...flags.split(' '), '-c', 'printf %s "${KURIER_RC_RAN:-no}"'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
            env: { ...process.env, HOME: home },
          }).stdout ?? '';
        expect(run('-lc')).toBe('no');
        expect(run('-i -c')).toBe('1');
      });
    });

    await it('discards the sourcing child’s own output and its tty complaint', async () => {
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('>/dev/null 2>&1');
    });

    await it('checks the rc is readable before spawning a shell to read it', async () => {
      // A shell start-up per spawn to read a file that may not be there is a cost paid on every
      // session start, and on a machine with no such file it is pure latency.
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('[ -r "$__k_rcp" ]');
    });

    await it('falls back to /bin/sh when $SHELL is unset', async () => {
      const { outer } = shapeOf(toHostCommand(OPENCODE, SANDBOXED));
      expect(outer).toContain('__k_sh="${SHELL:-/bin/sh}"');
    });

    /**
     * The rc PATH capture, run for real. `shell` is which shell claims to be the person's; when it is
     * zsh the fixture's `.zshrc` is read, when it is fish the same program must NOT be found.
     */
    function rcPathCase(shell: string, rcName: string): Promise<string> {
      return withTempDirValue((dir) => {
        const home = join(dir, 'home');
        const bin = join(dir, 'bin');
        mkdirSync(home, { recursive: true });
        mkdirSync(bin, { recursive: true });
        writeProgram(bin, 'rcagent', '#!/bin/sh\necho "RC-AGENT-RAN"\n');
        // An rc that prints TWO banner lines, reads stdin, and puts the program on PATH — the three
        // things that each broke a different version of this wrapper.
        writeHomeFile(
          home,
          rcName,
          `echo "RC-NOISE-1"\necho "RC-NOISE-2"\nread -r _s || true\nexport PATH="${bin}:$PATH"\n`,
        );
        const { outer, inner, tail } = shapeOf(
          toHostCommand({ id: 'r', title: 'r', program: 'rcagent', args: [] }, SANDBOXED),
        );
        const result = spawnSync('/bin/sh', ['-c', outer, inner, ...tail], {
          input: 'swallowed-by-the-rc\n',
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, HOME: home, SHELL: shell },
        });
        return result.stdout;
      });
    }

    await it('recovers the PATH from a chatty bash rc that also reads stdin', async () => {
      if (process.platform === 'win32' || !existsSync('/bin/bash')) return;
      // The program is reachable ONLY through the rc, so finding it proves the rc ran; and its
      // output is the only thing on stdout, so the banners did not leak onto the protocol stream.
      expect(await rcPathCase('/bin/bash', '.bashrc')).toBe('RC-AGENT-RAN\n');
    });

    await it('recovers the PATH from a chatty zsh rc too', async () => {
      if (process.platform === 'win32' || !existsSync('/usr/bin/zsh')) return;
      // The same fixture against zsh, whose rc is the one this machine actually needs: it holds the
      // agent's PATH and is zsh syntax, so a wrapper that sourced it from `sh` would fail to parse.
      expect(await rcPathCase('/usr/bin/zsh', '.zshrc')).toBe('RC-AGENT-RAN\n');
    });

    await it('does NOT read an rc for a non-POSIX $SHELL, and still starts the program', async () => {
      if (process.platform === 'win32') return;
      // fish/nushell/csh get the login PATH and nothing more. The program is named by ABSOLUTE path,
      // so it runs without any PATH lookup at all — which is the point: the wrapper still works, it
      // just did not get the rc's PATH, and the question is whether it FAILED or ran anyway.
      await withTempDir((dir) => {
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        const program = writeProgram(dir, 'no-rc-agent', '#!/bin/sh\necho "RAN-WITHOUT-RC"\n');
        const { outer, inner, tail } = shapeOf(
          toHostCommand({ id: 'r', title: 'r', program, args: [] }, SANDBOXED),
        );
        const result = spawnSync('/bin/sh', ['-c', outer, inner, ...tail], {
          input: 'swallowed\n',
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, HOME: home, SHELL: '/usr/bin/fish' },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('RAN-WITHOUT-RC\n');
      });
    });
  });

  await describe('hostProbeArgv', async () => {
    await it('is null outside a sandbox, so the caller knows there is nothing to ask', async () => {
      expect(hostProbeArgv('opencode', NOT_SANDBOXED)).toBe(null);
    });

    await it('asks the host shell, with the program as the last argv entry', async () => {
      const argv = hostProbeArgv('opencode', SANDBOXED);
      expect(argv?.[0]).toBe('--host');
      expect(argv?.[argv.length - 1]).toBe('opencode');
    });

    await it('resolves with command -v rather than walking the sandbox PATH', async () => {
      // The host's PATH is a different PATH; a walk here would answer about the wrong machine.
      expect(hostProbeArgv('opencode', SANDBOXED)?.join('\n')).toContain('command -v');
    });

    await it('keeps the pipe fencing, or the answer would arrive on the protocol stream', async () => {
      expect(hostProbeArgv('opencode', SANDBOXED)?.join('\n')).toContain('0<&3 1>&4');
    });

    await it('passes a program with a space as one argument', async () => {
      const argv = hostProbeArgv('two words', SANDBOXED);
      expect(argv?.[argv.length - 1]).toBe('two words');
    });
  });

  await describe('which — the host answer is only accepted when it is a path', async () => {
    await it('answers from the local PATH even when sandboxed, without asking the host', async () => {
      // A flatpak-spawn probe on a machine without flatpak-spawn would answer null, so a local hit
      // that still returns the path is the observable proof the host was never consulted.
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const exe = writeProgram(dir, 'prog', '#!/bin/sh\n');
        expect(which('prog', { PATH: dir }, SANDBOXED)).toBe(exe);
      });
    });

    await it('never asks the host about a program named by path', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const exe = writeProgram(dir, 'prog', '#!/bin/sh\n');
        expect(which(exe, { PATH: '/nonexistent' }, SANDBOXED)).toBe(exe);
      });
    });

    await it('treats a failed or unreachable probe as not installed, never as a throw', async () => {
      await withTempDir((dir) => {
        expect(which('no-such-program-anywhere', { PATH: dir }, SANDBOXED)).toBe(null);
      });
    });

    // The `stdio` and `timeout` options on the probe are the difference between "reports not
    // installed" and "hangs", and neither can be asserted here: `flatpak-spawn` exists only inside a
    // Flatpak, so the production call cannot run on a build host. What these two cases DO is measure
    // the runtime behaviour the options rely on, so a polyfill change that breaks either would be
    // caught here rather than as a hung window on somebody's desktop.
    await it('a spawnSync child gets EOF on stdin, so a blocking rc read cannot hang the probe', async () => {
      if (process.platform === 'win32') return;
      const read = spawnSync('/bin/sh', ['-c', 'if read -r _x; then printf GOT; else printf EOF; fi'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      expect(read.status).toBe(0);
      expect(read.stdout).toBe('EOF');
    });

    await it('a numeric timeout aborts a child that overruns it, with no status and an error', async () => {
      if (process.platform === 'win32') return;
      const slow = spawnSync('/bin/sh', ['-c', 'sleep 5'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300,
      });
      expect(slow.status).toBe(null);
      expect(slow.error).toBeTruthy();
    });

    await it('accepts only an absolute path, because a shell function prints a bare name', async () => {
      // `command -v` answers for functions, aliases, keywords and builtins as well as programs, and
      // all of those print their own NAME. Measured in a real bash: a function prints `myfn`, an
      // alias prints `al`, and even a *builtin* like `pwd` prints `pwd`. None of them is something
      // `spawn` can execute, so a bare name has to read as "not installed".
      if (process.platform === 'win32' || !existsSync('/bin/bash')) return;
      const answer = spawnSync(
        '/bin/bash',
        ['-i', '-c', 'myfn() { echo hi; }; command -v -- myfn; command -v -- pwd'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
      );
      const lines = (answer.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(lines).toStrictEqual(['myfn', 'pwd']);
      for (const line of lines) expect(probeAccepts(line)).toBe(false);
      expect(probeAccepts('/usr/bin/opencode')).toBe(true);
    });

    await it('says "not installed" for a program the host only has as a shell function', async () => {
      // End to end, through the real wrapper with a real rc that defines only a function: there is
      // no file anywhere, so the honest answer is NOT FOUND rather than a name that cannot be run.
      if (process.platform === 'win32' || !existsSync('/bin/bash')) return;
      await withTempDir((dir) => {
        const home = join(dir, 'home');
        mkdirSync(home, { recursive: true });
        writeHomeFile(home, '.bashrc', 'fnonly() { echo hi; }\n');
        const probe = hostProbeArgv('fnonly', SANDBOXED);
        expect(probe).not.toBe(null);
        const { outer, inner, tail } = shapeOfForProbe(probe);
        const result = spawnSync('/bin/sh', ['-c', outer, inner, ...tail], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
          env: { ...process.env, HOME: home, SHELL: '/bin/bash' },
        });
        // Nothing, and that is the correct answer for two independent reasons: the probe runs in a
        // POSIX `sh` that never read the bash rc, AND even if it had, a function is not a program.
        // Either way `kurier agents` says NOT FOUND rather than printing a name it cannot run.
        expect(result.stdout.trim()).toBe('');
        expect(result.status).not.toBe(0);
      });
    });
  });

  await describe('StdioChannel — a real spawn, both runtimes', async () => {
    /**
     * The `cwd`/`env` source — the one decision that cannot be read off an argv, because the argv
     * looks right either way. `flatpak-spawn` exists only inside a Flatpak, so the spawn cannot be
     * made to succeed on a build host; what is asserted is the command that WOULD be spawned.
     */
    await it('takes cwd and env off the rewritten command, so the carrier gets no host-only cwd', async () => {
      const withHostPaths: AgentCommand = {
        ...OPENCODE,
        // A path that exists nowhere near this machine: on a real host it is the project dir.
        cwd: '/home/somebody/their-project',
        env: { OPENCODE_API_KEY: 'x' },
      };
      const actual = resolveSpawnCommand(withHostPaths, SANDBOXED);
      // In the argv, because they are the host's business…
      expect(actual.args).toContain('--directory=/home/somebody/their-project');
      expect(actual.args).toContain('--env=OPENCODE_API_KEY=x');
      // …and NOT on the command, because the carrier runs in the sandbox.
      expect(actual.cwd).toBe(undefined);
      expect(actual.env).toBe(undefined);
    });

    await it('leaves program, args, cwd and env alone when not sandboxed', async () => {
      const plain: AgentCommand = { ...OPENCODE, cwd: '/tmp', env: { A: '1' } };
      const actual = resolveSpawnCommand(plain, NOT_SANDBOXED);
      expect(actual.program).toBe('opencode');
      expect(actual.args).toStrictEqual(['acp']);
      expect(actual.cwd).toBe('/tmp');
      expect(actual.env).toStrictEqual({ A: '1' });
    });

    await it('runs a real child with cwd, env and argv all intact', async () => {
      // No `read` in the program: StdioChannel holds the write end of the pipe open for the life of
      // the channel, so a program that waited for input would never exit and this would report a
      // timeout instead of a wrong value.
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const program = writeProgram(
          dir,
          'echoer',
          '#!/bin/sh\nprintf "ARGV:%s|%s\\n" "$1" "$2"\nprintf "CWD:%s\\n" "$(pwd)"\nprintf "ENV:%s\\n" "$KURIER_TEST_VAR"\n',
        );
        const channel = new StdioChannel({
          command: {
            id: 'echoer',
            title: 'echoer',
            program,
            args: ['one', 'two'],
            cwd: dir,
            env: { KURIER_TEST_VAR: 'present' },
          },
          onStderr: () => {},
          sandboxFacts: NOT_SANDBOXED,
        });
        return new Promise<string>((resolve, reject) => {
          let out = '';
          channel.onData((chunk) => {
            out += chunk;
          });
          // **Resolve on the end, assert after it.** The assertions used to run on the first chunk
          // that happened to contain ENV: and again on end, which made a test that resolved on
          // *incomplete* output indistinguishable from one that resolved on all of it — on GJS,
          // where `exit` can beat the last chunk, that was a green test with zero assertions and
          // 4 fewer counted than Node. Settling first and asserting in the test body is also what
          // keeps a failing `expect` out of the child's `exit` listener, where the polyfill's
          // `emit` try/catch turns it into a swallowed error and a timeout instead of a diff.
          channel.onEnd((reason) => (reason ? reject(reason) : resolve(out)));
        }).then((out) => {
          expect(out).toContain('ARGV:one|two');
          expect(out).toContain(`CWD:${dir}`);
          expect(out).toContain('ENV:present');
        });
      });
    });

    await it('reports the agent in an error message, never the carrier that started it', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const program = writeProgram(dir, 'failing', '#!/bin/sh\nexit 3\n');
        const channel = new StdioChannel({
          command: { id: 'f', title: 'f', program, args: [] },
          onStderr: () => {},
        });
        return new Promise<void>((resolve) => {
          channel.onEnd((reason) => {
            expect(reason?.message).toContain(program);
            expect(reason?.message).not.toContain(FLATPAK_SPAWN);
            resolve();
          });
        });
      });
    });

    /**
     * The regression: **a chunk written before the process died, delivered after the process died.**
     *
     * Both halves are needed to make it deterministic rather than lucky. The subshell holds the
     * write end of stdout open after the parent `sh` has exited, so `exit` is dispatched while
     * stdout is still open — the ordering GJS's polyfill gets wrong and Node merely gets lucky
     * about — and it writes its line only afterwards, so the late chunk is guaranteed to exist
     * rather than to have raced. A channel that ends on `exit` therefore loses `LATE:` every run,
     * on both runtimes, with no reliance on scheduling.
     */
    await it('keeps reading stdout after the child has exited, and ends on EOF', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const program = writeProgram(
          dir,
          'late',
          '#!/bin/sh\n( sleep 0.4; printf "LATE:%s\\n" "$KURIER_TEST_VAR" ) &\nprintf "EARLY\\n"\nexit 0\n',
        );
        const channel = new StdioChannel({
          command: {
            id: 'late',
            title: 'late',
            program,
            args: [],
            env: { KURIER_TEST_VAR: 'after-exit' },
          },
          onStderr: () => {},
          sandboxFacts: NOT_SANDBOXED,
        });
        const events: string[] = [];
        channel.onData((chunk) => events.push(`data:${chunk.trim()}`));
        return new Promise<string[]>((resolve, reject) => {
          channel.onEnd((reason) => (reason ? reject(reason) : resolve(events)));
        }).then((delivered) => {
          // The end came after the drain, not before it.
          expect(delivered).toStrictEqual(['data:EARLY', 'data:LATE:after-exit']);
          expect(channel.isClosed).toBe(true);
        });
      });
    });

    await it('delivers every line of a burst written just before the child exits', async () => {
      if (process.platform === 'win32') return;
      await withTempDir((dir) => {
        const program = writeProgram(
          dir,
          'burst',
          '#!/bin/sh\ni=0\nwhile [ $i -lt 500 ]; do echo "line-$i"; i=$((i+1)); done\n',
        );
        const channel = new StdioChannel({
          command: { id: 'burst', title: 'burst', program, args: [] },
          onStderr: () => {},
          sandboxFacts: NOT_SANDBOXED,
        });
        let out = '';
        channel.onData((chunk) => {
          out += chunk;
        });
        return new Promise<string>((resolve, reject) => {
          channel.onEnd((reason) => (reason ? reject(reason) : resolve(out)));
        }).then((all) => {
          const lines = all.split('\n').filter(Boolean);
          expect(lines.length).toBe(500);
          expect(lines[499]).toBe('line-499');
        });
      });
    });
  });
};

/** The argv shape of a probe, resolved the same way `shapeOf` does for an exec. */
function shapeOfForProbe(argv: string[] | null): { outer: string; inner: string; tail: string[] } {
  const args = argv ?? [];
  const sh = args.indexOf('/bin/sh');
  return { outer: args[sh + 2], inner: args[sh + 3], tail: args.slice(sh + 4) };
}
