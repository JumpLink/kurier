#!/usr/bin/env node
/**
 * Does the code still agree with the protocol?
 *
 * The types in `packages/acp/src/types.ts` are hand-written against `refs/acp/schema.v1.json`,
 * which is the whole reason that file is vendored. But a hand-written copy of a schema drifts the
 * moment upstream moves, and drift here is silent: a renamed method becomes a runtime "method not
 * found" against a live agent, and a field that became required becomes an agent that ignores what
 * kurier sent. Both are found in production, not in the build.
 *
 * So this script reads the schema and checks the two things that actually break:
 *
 * 1. **Every method in the schema is spelled the same way in `methods.ts`.** A typo in a `method:`
 *    field is the cheapest possible bug to introduce and the most expensive to find.
 * 2. **Every field the schema marks required is marked required in the TypeScript interface.** This
 *    is the half that matters most in one direction: making an optional field required rejects
 *    valid agents, and only the schema can say which is which.
 *
 * Deliberately NOT checked: the field *types*. Deriving TypeScript from JSON Schema is a
 * generator, and a generated `types.ts` nobody wrote is a file nobody can review in a diff. The
 * types stay hand-written; this script keeps them honest about names and requiredness, which is
 * where the drift costs a debugging session.
 *
 *   node scripts/check-schema.mjs          # check
 *   node scripts/check-schema.mjs --quiet  # exit code only, for CI
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCHEMA = join(ROOT, 'refs', 'acp', 'schema.v1.json');
const METHODS = join(ROOT, 'packages', 'acp', 'src', 'methods.ts');
const TYPES = join(ROOT, 'packages', 'acp', 'src', 'types.ts');

const quiet = process.argv.includes('--quiet');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const defs = schema.$defs ?? {};

// ─── 1. method names ────────────────────────────────────────────────────────────────────────

/** Every `x-method` in the schema, with the side the schema records. */
const schemaMethods = new Map();
for (const [name, def] of Object.entries(defs)) {
  const method = def?.['x-method'];
  if (typeof method === 'string' && !schemaMethods.has(method)) {
    schemaMethods.set(method, { side: def['x-side'] ?? 'protocol', from: name });
  }
}

const methodsSource = readFileSync(METHODS, 'utf8');
/** The literal table values: `newSession: 'session/new',` */
const codeMethods = new Map();
for (const match of methodsSource.matchAll(/(\w+):\s*'([^']+)'/g)) {
  codeMethods.set(match[2], match[1]);
}

for (const [method, info] of schemaMethods) {
  if (method.startsWith('$/')) continue; // `$/cancel_request` is a notification, not in the table
  if (!codeMethods.has(method)) {
    fail(`${METHODS}: the schema has "${method}" (${info.side}, ${info.from}) and methods.ts does not`);
  }
}
for (const method of codeMethods.keys()) {
  if (!schemaMethods.has(method)) {
    fail(`${METHODS}: methods.ts spells "${method}" and the schema does not have it`);
  }
}

// The direction that a stricter check earns its keep on: a client method that does not exist in the
// schema is a bug the agent will answer with -32601 forever.
const clientSide = [...schemaMethods.entries()].filter(([, info]) => info.side === 'agent');
notes.push(
  `${clientSide.length} client methods, ${schemaMethods.size - clientSide.length} client-side/other`,
);

// ─── 2. required fields on the interfaces the client actually sends ─────────────────────────

const typesSource = readFileSync(TYPES, 'utf8');

/** The interfaces a client request or response depends on. */
const LOAD_BEARING = [
  'InitializeRequest',
  'AuthenticateRequest',
  'NewSessionRequest',
  'LoadSessionRequest',
  'ResumeSessionRequest',
  'ListSessionsRequest',
  'SessionInfo',
  'PromptRequest',
  'PromptResponse',
  'CloseSessionRequest',
  'DeleteSessionRequest',
  'SessionNotification',
  'RequestPermissionRequest',
  'RequestPermissionResponse',
  'McpServerStdio',
  'McpServerHttp',
  'McpServerSse',
  'Implementation',
  // `ContentBlock` is a `oneOf` union, not an interface, so the check follows its branches. Those
  // are the content types that carry a required field of their own — the ones a mistake in would
  // send a malformed prompt.
  'TextContent',
  'ImageContent',
  'AudioContent',
  'ResourceLink',
];

/** `{ sessionId: SessionId; … }` — the `name?: type;` vs `name: type;` distinction, per interface. */
function interfaceFields(interfaceName) {
  const start = typesSource.indexOf(`export interface ${interfaceName} `);
  if (start < 0) return null;
  const open = typesSource.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < typesSource.length; i++) {
    if (typesSource[i] === '{') depth++;
    else if (typesSource[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = typesSource.slice(open + 1, end);
  const required = new Set();
  const optional = new Set();
  for (const line of body.split('\n')) {
    // One property per line, by house style. A wrapped property is not silently skipped: the
    // `?` check below is what would catch it, and a skipped line shows up as "missing in TS",
    // which is a failure worth reading.
    const match = /^\s{2}(\w+)(\?)?\s*:/.exec(line);
    if (!match) continue;
    (match[2] ? optional : required).add(match[1]);
  }
  return { required, optional };
}

for (const name of LOAD_BEARING) {
  const ts = interfaceFields(name);
  if (!ts) {
    fail(`${TYPES}: no interface named ${name} — the drift check cannot see it`);
    continue;
  }
  const spec = defs[name];
  if (!spec) {
    fail(`refs/acp/schema.v1.json: no definition named ${name}`);
    continue;
  }
  for (const field of schemaRequired(spec)) {
    if (!ts.required.has(field)) {
      fail(
        `${name}.${field} is required by the schema but not by the TypeScript interface — ` +
          'a client that omits it sends an invalid request',
      );
    }
  }
  // The other direction, reported but not failed: a field the schema marks optional that the
  // interface requires is a client that rejects valid agents. That is worth knowing too, and it
  // is a note rather than a failure because some fields are required *by kurier's own use* of
  // them (e.g. `NewSessionRequest.cwd` is echoed into the session record).
  for (const field of ts.required) {
    // `type` is ACP's union discriminator — the schema declares it on the `anyOf` wrapper
    // (`McpServer`, `ContentBlock`, `SessionUpdate`), not on the branch. A branch interface that
    // pins it is exactly right, so it is not a note.
    if (field === 'type') continue;
    if (schemaOptional(spec, field)) {
      notes.push(`${name}.${field} is required in TypeScript, optional in the schema`);
    }
  }
}

/** The schema's own `required` array, following the `allOf` shape it uses for `$ref`s. */
function schemaRequired(spec) {
  if (Array.isArray(spec.required)) return spec.required;
  for (const branch of spec.allOf ?? []) {
    if (branch.$ref) {
      const name = branch.$ref.split('/').pop();
      const resolved = defs[name];
      if (resolved) return schemaRequired(resolved);
    }
  }
  return [];
}

function schemaOptional(spec, field) {
  // Only a definition that carries its own `required` array can be "stricter than the schema".
  // `McpServerHttp` has none: the `type: 'http'` tag is required by the `McpServer` anyOf wrapper,
  // not by the branch, so a note about it would be a false positive.
  if (!Array.isArray(spec.required)) return false;
  return !spec.required.includes(field);
}

// ─── report ─────────────────────────────────────────────────────────────────────────────────

for (const note of notes) {
  if (!quiet) console.log(`note  ${note}`);
}
if (problems.length > 0) {
  console.error(`\nschema check FAILED (${problems.length}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `schema check ok — ${schemaMethods.size} methods, ${LOAD_BEARING.length} interfaces, against refs/acp/schema.v1.json`,
);
