#!/usr/bin/env node
/**
 * Does opencode report which providers are connected? No model call, no real credential.
 *
 * Starts `opencode serve --port 0` with a throwaway HOME and XDG_* tree and a per-run password, reads
 * `GET /api/integration`, connects one provider with a made-up key (`POST .../connect/key`), and reads
 * it again. The fake key lives only in the scratch tree, which is removed at the end.
 *
 * Usage: node scripts/probes/provider-connections.mjs [opencode-binary]
 * Exit code 0 = connections reported (empty before, one entry after), 1 = not.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.argv[2] ?? 'opencode';
const root = mkdtempSync(join(tmpdir(), 'kurier-probe-'));
const dirs = {
  HOME: 'h',
  XDG_CONFIG_HOME: 'c',
  XDG_DATA_HOME: 'd',
  XDG_STATE_HOME: 's',
  XDG_CACHE_HOME: 'k',
};
const env = { ...process.env, OPENCODE_SERVER_PASSWORD: 'probe-pw' };
for (const [name, dir] of Object.entries(dirs)) {
  mkdirSync(join(root, dir));
  env[name] = join(root, dir);
}

const child = spawn(binary, ['serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no port within 20s')), 20_000);
  child.stdout.on('data', (chunk) => {
    const match = /listening on (http:\/\/\S+)/.exec(String(chunk));
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
});
const headers = { authorization: `Basic ${btoa('opencode:probe-pw')}` };

async function connected() {
  const body = await (await fetch(`${url}/api/integration`, { headers })).json();
  return body.data.filter((p) => p.connections?.length).map((p) => ({ id: p.id, n: p.connections.length }));
}

let ok = false;
try {
  const before = await connected();
  const response = await fetch(`${url}/api/integration/scaleway/connect/key`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ methodID: 'key', key: 'probe-not-a-key' }),
  });
  const after = await connected();
  console.log('connected before:', JSON.stringify(before));
  console.log('connect/key status:', response.status);
  console.log('connected after: ', JSON.stringify(after));
  ok = before.length === 0 && after.length === 1 && after[0].id === 'scaleway';
} finally {
  child.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'REPORTED: /api/integration carries `connections`' : 'NOT REPORTED');
process.exit(ok ? 0 : 1);
