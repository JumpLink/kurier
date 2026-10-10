/**
 * The private `opencode serve` — against a stand-in program that prints the line the real one prints.
 * A real spawn on both runtimes; no network is touched, the stand-in listens on nothing.
 */

import { describe, expect, it } from '@gjsify/unit';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serverCommand, startServer, whyNoLoginServer, type AgentCommand } from '@lotse/core';

function agent(program: string, extra: Partial<AgentCommand> = {}): AgentCommand {
  return { id: 'opencode', title: 'opencode', program, args: ['acp'], ...extra };
}

async function withProgram(
  body: string,
  run: (program: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kurier-server-'));
  try {
    const program = join(dir, 'fake-opencode');
    writeFileSync(program, `#!/bin/sh\n${body}\n`);
    chmodSync(program, 0o755);
    await run(program, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async () => {
  await describe('serverCommand', async () => {
    await it('is the same program and environment with the serve arguments, on a port the OS picks', async () => {
      const command = serverCommand(agent('/x/opencode', { env: { XDG_DATA_HOME: '/d' }, bundled: true }));
      expect(command.program).toBe('/x/opencode');
      expect(command.args.join(' ')).toBe('serve --port 0');
      expect(command.env!['XDG_DATA_HOME']).toBe('/d');
      expect(command.bundled).toBe(true);
    });
  });

  await describe('whyNoLoginServer', async () => {
    await it("explains a host copy under a Flatpak, which runs where this sandbox's loopback does not reach", async () => {
      expect(whyNoLoginServer(agent('opencode'), { flatpakInfoExists: true })!.includes('kurier auth')).toBe(
        true,
      );
    });

    await it('has nothing against a bundled copy in a sandbox, or any copy outside one', async () => {
      expect(whyNoLoginServer(agent('x', { bundled: true }), { flatpakInfoExists: true })).toBe(null);
      expect(whyNoLoginServer(agent('x'), { flatpakInfoExists: false })).toBe(null);
    });
  });

  await describe('startServer', async () => {
    await it('resolves with the address the server printed, and hands the child a password only it and we know', async () => {
      await withProgram(
        'printf "%s" "$OPENCODE_SERVER_PASSWORD" > "$(dirname "$0")/pw"\n' +
          'echo "server listening on http://127.0.0.1:38775"\nexec sleep 30',
        async (program, dir) => {
          const server = await startServer(agent(program), { timeoutMs: 5_000 });
          try {
            expect(server.baseUrl).toBe('http://127.0.0.1:38775');
            expect(server.password.length >= 32).toBe(true);
            expect(readFileSync(join(dir, 'pw'), 'utf8')).toBe(server.password);
          } finally {
            await server.close();
          }
        },
      );
    });

    await it('kills a server that ignores SIGTERM instead of hanging on close', async () => {
      await withProgram(
        'trap "" TERM\necho "server listening on http://127.0.0.1:2"\nwhile :; do sleep 1; done',
        async (program) => {
          const server = await startServer(agent(program));
          const began = Date.now();
          await server.close();
          expect(Date.now() - began < 10_000).toBe(true);
        },
      );
    });

    await it('gives every start its own password', async () => {
      await withProgram('echo "server listening on http://127.0.0.1:1"\nexec sleep 30', async (program) => {
        const [a, b] = [await startServer(agent(program)), await startServer(agent(program))];
        try {
          expect(a.password === b.password).toBe(false);
        } finally {
          await a.close();
          await b.close();
        }
      });
    });

    await it('rejects when the program stops before it listens', async () => {
      await withProgram('echo "boom" >&2\nexit 3', async (program) => {
        let message = '';
        try {
          await startServer(agent(program), { timeoutMs: 5_000 });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message.includes('stopped before it listened')).toBe(true);
        expect(message.includes('3')).toBe(true);
      });
    });

    await it('rejects, and stops the child, when it never says where it listens', async () => {
      await withProgram('exec sleep 30', async (program) => {
        let message = '';
        try {
          await startServer(agent(program), { timeoutMs: 300 });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message.includes('did not report a port')).toBe(true);
      });
    });

    await it('rejects for a program that is not there', async () => {
      let thrown = false;
      try {
        await startServer(agent('/nonexistent/opencode'), { timeoutMs: 2_000 });
      } catch {
        thrown = true;
      }
      expect(thrown).toBe(true);
    });
  });
};
