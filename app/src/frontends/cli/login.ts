/**
 * `kurier login` — log in to a provider through opencode's own OAuth flow, without a terminal login.
 *
 * `kurier auth` hands the person to `opencode auth login`, which needs a terminal and a menu. This is the
 * other path, the one a window can use too: kurier starts a private `opencode serve`, asks it to begin the
 * login, shows the URL and the code it answers with, and waits until the provider is done. It stores
 * nothing — the credential lands in the agent's own store (`core/login/flow.ts`).
 *
 * ```
 * kurier login                       # the providers on offer
 * kurier login poe                   # one method: starts the login
 * kurier login openai --method chatgpt-headless
 * kurier login github-copilot --method device --answer deploymentType=github.com
 * echo "$KEY" | kurier login scaleway   # an API key: read from stdin, never from an argument
 * ```
 *
 * It needs opencode v2. v1 has no such API and answers a 404 on the catalog, which this reports as
 * "use `kurier auth`" rather than as a failure.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import type { CommandModule } from 'yargs';

import { serverCommand, startServer, whyNoLoginServer } from '../../core/agents/server.ts';
import { currentSandboxFacts } from '../../core/agents/sandbox.ts';
import { which } from '../../core/agents/stdio.ts';
import { createLoginApi, LoginApiError } from '../../core/login/api.ts';
import { answersFor, runLogin, type LoginHooks } from '../../core/login/flow.ts';
import type { LoginMethod, LoginProvider } from '../../core/login/providers.ts';

import { agentForNew } from './choose.ts';
import { err, out, pickArgv } from './output.ts';

function parseAnswers(raw: unknown): Record<string, string> | string {
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const answers: Record<string, string> = {};
  for (const entry of entries) {
    const text = String(entry);
    const at = text.indexOf('=');
    if (at < 1) return `--answer wants key=value, got "${text}"`;
    answers[text.slice(0, at)] = text.slice(at + 1);
  }
  return answers;
}

function listProviders(providers: readonly LoginProvider[]): void {
  for (const provider of providers) {
    out(`${provider.id} — ${provider.name}${provider.connected ? '  (connected)' : ''}`);
    for (const method of provider.methods) {
      out(
        `    --method ${method.id}   ${method.label}${method.kind === 'key' ? '  (key read from stdin)' : ''}`,
      );
    }
  }
}

function describeField(method: LoginMethod, key: string): string {
  const field = method.fields.find((candidate) => candidate.key === key);
  if (!field) return key;
  const options = field.options?.map((option) => option.value).join(' | ');
  return `${field.title} (${key})${options ? `: ${options}` : ''}`;
}

/** One line from stdin, or `null` when there is no person to ask (a pipe, a closed stdin). */
function readLine(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.once('close', () => resolve(null));
  });
}

/**
 * A key from stdin, never from an argument: an argument is in the process list and the shell history.
 * On a terminal the typed characters are not echoed; a pipe is read to its end.
 */
async function readSecret(prompt: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    // Events, not `for await`: GJS's stdin is not async-iterable (measured: "process.stdin is not iterable").
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
      process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim() || null));
      process.stdin.once('error', () => resolve(null));
      // The command's own SIGINT handler replaced the default one, so a never-ending stdin would hang.
      process.once('SIGINT', () => resolve(null));
    });
  }
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim() || null);
    });
    rl.once('close', () => resolve(null));
  });
}

const command: CommandModule = {
  command: 'login [provider]',
  describe: 'log in to a provider (browser login or API key) through the agent, with no terminal login',
  builder: (yargs) =>
    yargs
      .positional('provider', { type: 'string', describe: 'which provider; none lists them' })
      .option('method', {
        type: 'string',
        describe: 'which way to log in; needed when there is more than one',
      })
      .option('answer', {
        type: 'string',
        array: true,
        describe: 'a field the method asks for, as key=value',
      })
      .option('agent', {
        type: 'string',
        describe: 'which agent (default: your own install, else the bundled copy)',
      })
      .strict(),
  handler: async (argv) => {
    const raw = argv as Record<string, unknown>;
    const resolved = agentForNew(pickArgv<string>(raw, 'agent'));
    if (!resolved) return;
    const agent = resolved.command;

    const reason = whyNoLoginServer(agent, currentSandboxFacts());
    if (reason) {
      err(reason);
      process.exitCode = 1;
      return;
    }
    if (!which(agent.program)) {
      err(`${agent.program} is not on PATH — install it, or point PATH at it, then try again`);
      process.exitCode = 1;
      return;
    }
    const given = parseAnswers(pickArgv<unknown>(raw, 'answer'));
    if (typeof given === 'string') {
      err(given);
      process.exitCode = 1;
      return;
    }
    if (resolved.isolation) {
      err(`  a login here is kept in ${resolved.isolation.data} and is not your own opencode login`);
    }

    const server = await startServer(agent).catch((error: unknown) => {
      err(
        `could not start ${serverCommand(agent).title}'s login server: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (!server) {
      process.exitCode = 1;
      return;
    }
    let cancelled = false;
    const onInterrupt = (): void => {
      cancelled = true;
    };
    process.on('SIGINT', onInterrupt);
    try {
      const api = createLoginApi(server.send);
      let providers: LoginProvider[];
      try {
        providers = await api.providers();
      } catch (error) {
        if (error instanceof LoginApiError && error.httpStatus === 404) {
          err(`this opencode has no login API (it needs v2) — run \`kurier auth\` instead`);
        } else {
          err(`could not read the provider list: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exitCode = 1;
        return;
      }

      const wanted = pickArgv<string>(raw, 'provider');
      if (!wanted) {
        listProviders(providers);
        return;
      }
      const provider = providers.find((candidate) => candidate.id === wanted.toLowerCase());
      if (!provider) {
        err(`"${wanted}" is not a provider kurier offers a login for. These are:`);
        listProviders(providers);
        process.exitCode = 1;
        return;
      }
      const methodId = pickArgv<string>(raw, 'method');
      const method = methodId
        ? provider.methods.find((candidate) => candidate.id === methodId)
        : provider.methods.length === 1
          ? provider.methods[0]
          : undefined;
      if (!method) {
        err(
          methodId
            ? `${provider.name} has no method "${methodId}". It has:`
            : `${provider.name} has more than one way — pick one:`,
        );
        listProviders([provider]);
        process.exitCode = 1;
        return;
      }
      const { answer, missing } = answersFor(method, given);
      if (missing.length > 0) {
        err(`${method.label} needs more before it can start:`);
        for (const field of missing) err(`    --answer ${describeField(method, field.key)}`);
        process.exitCode = 1;
        return;
      }

      if (method.kind === 'key') {
        const key = await readSecret(`${provider.name} API key: `);
        if (!key) {
          err('no key given — pipe it in (`… | kurier login <provider>`) or run this in a terminal.');
          process.exitCode = 1;
          return;
        }
        try {
          await api.connectKey(provider.id, key, answer);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          err(`the key was not accepted: ${reason.split(key).join('[key]')}`);
          process.exitCode = 1;
          return;
        }
        out(`logged in to ${provider.name}.`);
        err('  an agent that is already running may need a restart to see it.');
        return;
      }

      const hooks: LoginHooks = {
        show: (prompt) => {
          err(`\nOpen ${prompt.url}`);
          if (prompt.instructions) err(`  ${prompt.instructions}`);
          err(
            prompt.mode === 'code'
              ? '  then paste the code the page shows you.'
              : '  kurier waits here until the provider is done. Ctrl-C cancels.',
          );
        },
        askCode: () => readLine('code: '),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        isCancelled: () => cancelled,
      };
      const result = await runLogin(api, provider.id, method.id, answer, hooks);
      switch (result.kind) {
        case 'connected':
          out(`logged in to ${provider.name}.`);
          err('  an agent that is already running may need a restart to see it.');
          return;
        case 'failed':
          err(`the login failed: ${result.message}`);
          break;
        case 'expired':
          err('the login ran out of time — start it again.');
          break;
        case 'cancelled':
          err('cancelled.');
          break;
      }
      process.exitCode = 1;
    } finally {
      process.off('SIGINT', onInterrupt);
      await server.close();
      // The command is finished, so end it. Measured on GJS: any child `startServer` has launched — even
      // a plain `sh` that exits by itself — leaves the main loop running after the handler returns, while
      // the same child through a bare `spawn` does not; the cause is not isolated yet. Without this line
      // `kurier login` prints its result and then never returns. The delay lets stdout drain first.
      setTimeout(() => process.exit(process.exitCode ?? 0), 50);
    }
  },
};

export const loginCommand = command;
