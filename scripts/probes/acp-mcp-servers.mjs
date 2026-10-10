#!/usr/bin/env node
/**
 * Does `opencode acp` honour `mcpServers` in `session/new`? No model call, no login.
 *
 * The probe starts opencode with a throwaway HOME and XDG_* tree, so nothing touches the person's
 * own ~/.config/opencode or their login. It passes this very file (run with `--mcp`) as a stdio MCP
 * server exposing one tool, `probe_echo`, and reads the server's own request log afterwards:
 * `initialize` + `tools/list` arriving there means opencode spawned the server and asked for its tools.
 *
 * Usage: node scripts/probes/acp-mcp-servers.mjs [opencode-binary]
 * Exit code 0 = honoured, 1 = not honoured.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function runMcpServer() {
  const log = (line) => process.env.PROBE_LOG && appendFileSync(process.env.PROBE_LOG, `${line}\n`);
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  log('started');
  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    log(`recv ${m.method ?? 'response'}`);
    if (m.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '0.0.1' },
        },
      });
    } else if (m.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          tools: [
            {
              name: 'probe_echo',
              description: 'Echo text',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
      });
    } else if (m.id !== undefined && m.method) {
      send({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  });
}

async function probe(binary) {
  const root = mkdtempSync(join(tmpdir(), 'kurier-probe-'));
  const log = join(root, 'mcp.log');
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const agent = spawn(binary, ['acp'], { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buffer = '';
  agent.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      } catch {
        /* not a response */
      }
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      agent.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    console.log('agent', JSON.stringify(init.result?.agentInfo));
    const session = await call('session/new', {
      cwd: root,
      mcpServers: [
        {
          name: 'probe',
          command: process.execPath,
          args: [SELF, '--mcp'],
          env: [{ name: 'PROBE_LOG', value: log }],
        },
      ],
    });
    console.log('session/new', session.error ? `error ${JSON.stringify(session.error)}` : 'ok');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const seen = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    console.log('mcp server saw:', seen.length ? seen.join(' | ') : '(nothing)');
    return seen.includes('recv tools/list');
  } finally {
    agent.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--mcp') {
  runMcpServer();
} else {
  const honoured = await probe(process.argv[2] ?? 'opencode');
  console.log(honoured ? 'RESULT: mcpServers honoured' : 'RESULT: mcpServers NOT honoured');
  process.exit(honoured ? 0 : 1);
}
