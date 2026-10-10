/**
 * The one test GJS is mandatory for: it proves the real ACP chain — spawn, handshake,
 * `session/new`, the unprompted `session/update` notification, clean shutdown — against a real
 * agent, entirely inside THIS GJS process, with no Node process anywhere in the chain. A pure
 * Node test would be green here and would not answer the question the plan asks (§6): whether
 * the stdio path actually works under GJS.
 *
 * It deliberately does NOT run a `session/prompt` turn. That costs a real model call against
 * whatever `opencode auth` is configured with, which would make this test slow and
 * quota-bound — and the point of this file is the chain up to and including the handshake and
 * `session/new`, not a conversation. The fs-refusal guardrail is asserted against the advertised
 * capability plus the direct `AcpClient` test in `../unit/acp/gate.test.ts`, not by forcing a
 * live turn to trigger it.
 *
 * NOT part of `gjsify test` / `test.mts`. Built and run explicitly:
 *   gjsify workspace lotse-cli test:real-agent
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpClient } from '@lotse/acp/client';
import { LOTSE_CLIENT_CAPABILITIES } from '@lotse/acp/gate';
import { channelTransport } from '@lotse/acp/transport';

import { OPENCODE_COMMAND, StdioChannel, which } from '@lotse/core';

let exitCode = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label}`);
    exitCode = 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const program = which(OPENCODE_COMMAND.program);
  if (!program) {
    console.log('SKIP: opencode is not on PATH — nothing to test the real chain against here.');
    process.exit(0);
  }
  console.log(`PASS: opencode found on PATH at ${program}`);

  const cwd = mkdtempSync(join(tmpdir(), 'lotse-real-agent-'));
  let channel: StdioChannel | undefined;
  let client: AcpClient | undefined;

  try {
    channel = new StdioChannel({
      command: OPENCODE_COMMAND,
      onStderr: (line) => console.error(`  [opencode stderr] ${line}`),
    });
    client = new AcpClient({ transport: channelTransport(channel) });

    const result = await client.initialize();
    check(
      true,
      'AcpClient.initialize completed inside this GJS process — no Node process anywhere in the chain',
    );

    const caps = result.agentCapabilities ?? {};
    console.log(`  agentCapabilities: ${JSON.stringify(caps)}`);
    check(caps.loadSession === true, 'agentCapabilities.loadSession is true');
    check(caps.mcpCapabilities?.http === true, 'agentCapabilities.mcpCapabilities.http is true');
    check(Boolean(caps.sessionCapabilities?.list), 'agentCapabilities.sessionCapabilities.list is truthy');
    check(
      Boolean(caps.sessionCapabilities?.resume),
      'agentCapabilities.sessionCapabilities.resume is truthy',
    );
    check(Boolean(caps.sessionCapabilities?.close), 'agentCapabilities.sessionCapabilities.close is truthy');
    check(
      Boolean(caps.sessionCapabilities?.delete),
      'agentCapabilities.sessionCapabilities.delete is truthy',
    );

    console.log(`  authMethods: ${JSON.stringify(client.authMethods)}`);
    check(Array.isArray(client.authMethods), 'authMethods is an array (the measured shape, printed above)');

    // The advertised capability, not a live fs/read_text_file round trip — see the file header.
    check(
      LOTSE_CLIENT_CAPABILITIES.fs?.readTextFile === false,
      'kurier advertises clientCapabilities.fs.readTextFile: false',
    );
    check(
      LOTSE_CLIENT_CAPABILITIES.fs?.writeTextFile === false,
      'kurier advertises clientCapabilities.fs.writeTextFile: false',
    );

    let sawAvailableCommands = false;
    client.onSessionUpdate((notification) => {
      if (notification.update.sessionUpdate === 'available_commands_update') sawAvailableCommands = true;
    });

    const session = await client.newSession({ cwd, mcpServers: [] });
    check(
      typeof session.sessionId === 'string' && session.sessionId.length > 0,
      'session/new (throwaway cwd) returned a session id',
    );

    // The unprompted notification is the exact bug the jsonrpc parser exists to catch — give the
    // event loop a few turns in case it lands a tick after session/new's own response.
    for (let i = 0; i < 25 && !sawAvailableCommands; i++) await sleep(20);
    check(
      sawAvailableCommands,
      'the unprompted session/update available_commands_update notification arrived',
    );

    client.close();
    channel.terminate();
    for (let i = 0; i < 100 && !channel.isClosed; i++) await sleep(50);
    check(channel.isClosed, 'the agent process is gone after a clean shutdown');
  } catch (error) {
    console.log(
      `FAIL: an unexpected error was thrown: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    exitCode = 1;
  } finally {
    client?.close();
    channel?.terminate();
    rmSync(cwd, { recursive: true, force: true });
  }

  console.log(exitCode === 0 ? 'SUMMARY: all checks passed' : 'SUMMARY: at least one check failed');
  process.exit(exitCode);
}

await main();
