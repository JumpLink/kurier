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

/**
 * The config-option `type`s and categories the TypeScript names, read out of `types.ts` rather than
 * imported.
 *
 * `check-schema.mjs` is a plain Node script with no workspace wiring, so it cannot import the
 * package it is checking — and duplicating the two lists here would be a second source of truth
 * that the check could not see drift in. These two are the exceptions to that rule, and the
 * negative tests below are what keep them honest.
 */
function constArrayInTypes(source, name) {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

const tsTypesSource = readFileSync(TYPES, 'utf8');
const KNOWN_CONFIG_OPTION_TYPES = constArrayInTypes(tsTypesSource, 'KNOWN_CONFIG_OPTION_TYPES') ?? [];
const KNOWN_CONFIG_CATEGORIES = constArrayInTypes(tsTypesSource, 'KNOWN_CONFIG_CATEGORIES') ?? [];
if (KNOWN_CONFIG_OPTION_TYPES.length === 0) {
  fail(`${TYPES}: no KNOWN_CONFIG_OPTION_TYPES const — the config-arm check would pass vacuously`);
}
if (KNOWN_CONFIG_CATEGORIES.length === 0) {
  fail(`${TYPES}: no KNOWN_CONFIG_CATEGORIES const — the category check would pass vacuously`);
}

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
  'SetSessionModeRequest',
  'SetSessionConfigOptionRequest',
  'SetSessionConfigOptionResponse',
  'SessionConfigSelectOption',
  'ConfigOptionUpdate',
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

// ─── 3. the agent→client direction ─────────────────────────────────────────────────────────
//
// Everything above checks what kurier SENDS. This part checks what an agent SENDS, which is where
// the drift is more dangerous: the client→agent direction fails loudly (a `-32601` against a live
// agent, in the first minute), while a wrongly-shaped inbound type fails silently — a capability
// read as absent, an `authMethods` entry read as the wrong variant, a new `sessionUpdate` variant
// quietly falling through to the wire listeners.
//
// That last one is not hypothetical. `SESSION_UPDATE_KINDS` in types.ts is a hand-maintained list of
// the schema's `SessionUpdate.oneOf` discriminators. If upstream adds a variant and the list is not
// extended, kurier keeps working — every new update goes to the wire listeners instead of the
// typed ones, and nothing anywhere reports it.

const TS_SOURCE = readFileSync(TYPES, 'utf8');

/** The `sessionUpdate` literals in `types.ts`'s `KnownSessionUpdate` union. */
function tsSessionUpdateKinds() {
  const start = TS_SOURCE.indexOf('export type KnownSessionUpdate');
  if (start < 0) return null;
  const end = TS_SOURCE.indexOf(';', start);
  const kinds = new Set();
  for (const match of TS_SOURCE.slice(start, end).matchAll(/sessionUpdate:\s*'([^']+)'/g)) {
    kinds.add(match[1]);
  }
  return kinds;
}

/** The discriminators of the schema's `SessionUpdate` oneOf, in schema order. */
function schemaSessionUpdateKinds() {
  const arms = defs['SessionUpdate']?.oneOf ?? defs['SessionUpdate']?.anyOf ?? [];
  const kinds = [];
  for (const arm of arms) {
    const tag = arm?.properties?.['sessionUpdate'] ?? {};
    if (typeof tag['const'] === 'string') kinds.push(tag['const']);
    else if (Array.isArray(tag['enum'])) kinds.push(...tag['enum']);
  }
  return kinds;
}

const tsKinds = tsSessionUpdateKinds();
const schemaKinds = schemaSessionUpdateKinds();

if (!tsKinds || schemaKinds.length === 0) {
  fail(`${TYPES}: could not read the session-update variants — the drift check cannot see them`);
} else {
  for (const kind of schemaKinds) {
    if (!tsKinds.has(kind)) {
      fail(
        `the schema defines sessionUpdate "${kind}" and SESSION_UPDATE_KINDS does not — kurier ` +
          'would route it to the wire listeners instead of the typed ones, with nothing reporting it',
      );
    }
  }
  for (const kind of tsKinds) {
    if (!schemaKinds.includes(kind)) {
      fail(`SESSION_UPDATE_KINDS names "${kind}" and the schema does not define it`);
    }
  }
  notes.push(`${schemaKinds.length} session-update variants`);
}

// Capability markers: the schema's `SessionCapabilities` is what `AcpClient` branches on, and a
// missing marker in the TypeScript is a capability kurier silently believes no agent has.
const SESSION_CAPABILITY_KEYS = Object.keys(defs['SessionCapabilities']?.properties ?? {}).filter(
  (key) => key !== '_meta',
);
const tsCapabilities = interfaceFields('SessionCapabilities');
if (!tsCapabilities) {
  fail(`${TYPES}: no interface named SessionCapabilities`);
} else if (SESSION_CAPABILITY_KEYS.length > 0) {
  for (const key of SESSION_CAPABILITY_KEYS) {
    if (!tsCapabilities.required.has(key) && !tsCapabilities.optional.has(key)) {
      fail(
        `SessionCapabilities.${key} is a capability marker in the schema and absent from the ` +
          'TypeScript — kurier would report the capability as unsupported for every agent',
      );
    }
  }
  notes.push(`${SESSION_CAPABILITY_KEYS.length} session-capability markers`);
}

// `authMethods` is trap 1 of the plan, and it is the one place where a wrong read changes what a
// person has to do by hand: misreading it as a terminal method means kurier never runs the login,
// and the first session dies on `-32000`. So the union is checked structurally — both branches must
// exist, and `AuthMethodInfo` must actually carry the fields the schema marks required.
// The union arms are inline wrappers, not bare `$ref`s: each is `{ properties: { type: { const } },
// required: ['type'], allOf: [{ $ref: '#/$defs/AuthMethodAgent' }] }`. Reading only `arm.$ref` finds
// nothing and the check then passes vacuously — a check that cannot fail is worse than no check,
// because it reads as coverage. So resolve both shapes.
const authArms = defs['AuthMethod']?.oneOf ?? defs['AuthMethod']?.anyOf ?? [];
const authBranches = authArms
  .map((arm) => arm?.$ref ?? (arm?.allOf ?? []).map((b) => b?.$ref).find(Boolean))
  .filter(Boolean)
  .map((ref) => String(ref).split('/').pop());
for (const branch of authBranches) {
  if (!defs[branch]) {
    fail(`the schema's AuthMethod references ${branch}, which is not in $defs`);
    continue;
  }
  const required = schemaRequired(defs[branch]);
  // `AuthMethodInfo` deliberately flattens both branches into one shape — an agent may omit the
  // `type` tag, which is the whole reason `kind` exists. So the requirement is that the fields
  // survive the flattening, not that the interfaces match one for one.
  const info = interfaceFields('AuthMethodInfo');
  if (!info) {
    fail(`${TYPES}: no interface named AuthMethodInfo`);
    continue;
  }
  for (const field of required) {
    if (!info.required.has(field) && !info.optional.has(field)) {
      fail(
        `AuthMethodInfo.${field} is required by the schema's ${branch} and absent from the ` +
          'TypeScript — the flattened auth method would lose it',
      );
    }
  }
}
notes.push(`${authBranches.length} auth-method variants`);

// ─── 4. session configuration: the `SessionConfigOption` `oneOf` ──────────────────────────────
//
// The config option is the one wire type in this file that is a **`oneOf` with a payload per arm**,
// and it is the one whose two arms disagree about what `currentValue` is: a value id for `select`,
// a boolean for `boolean`. A TypeScript mirror of that union cannot be narrowed without casts (see
// the note on `SessionConfigOption` in `types.ts`), so the wire type is flat and the validation
// lives in `app/src/core/config.ts`. That trade is only safe while this check is true, so it is
// asserted here rather than trusted:
//
// - both arms must exist in the schema and both must be named in `KNOWN_CONFIG_OPTION_TYPES`, so a
//   new arm cannot appear without kurier deciding what to do with it;
// - the fields the schema marks required **on each arm** must be checked, because that is the
//   information the flat type throws away.
//
// The category list is checked the same way. The schema says a category "MUST NOT be required for
// correctness", which is exactly why an unknown one must survive — so the check asserts that
// `KNOWN_CONFIG_CATEGORIES` names no category the schema does not define, in both directions.
const configArms = defs['SessionConfigOption']?.oneOf ?? [];
const schemaConfigTypes = configArms
  .map((arm) => arm?.properties?.type?.const)
  .filter((value) => typeof value === 'string');
if (schemaConfigTypes.length === 0) {
  fail('the schema’s SessionConfigOption has no oneOf arms with a type const — this check cannot see it');
}
for (const type of schemaConfigTypes) {
  if (!KNOWN_CONFIG_OPTION_TYPES.includes(type)) {
    fail(
      `SessionConfigOption has a "${type}" arm in the schema that KNOWN_CONFIG_OPTION_TYPES does not ` +
        'name — the projection would silently drop every option of that kind',
    );
  }
}
for (const type of KNOWN_CONFIG_OPTION_TYPES) {
  if (!schemaConfigTypes.includes(type)) {
    fail(`KNOWN_CONFIG_OPTION_TYPES names "${type}", which the schema’s SessionConfigOption does not define`);
  }
}
notes.push(`${schemaConfigTypes.length} config-option arms (${schemaConfigTypes.join(', ')})`);

for (const type of schemaConfigTypes) {
  const arm = configArms.find((entry) => entry?.properties?.type?.const === type);
  // The arm's own `required` covers `type`; the shared fields (`id`, `name`) and the arm's payload
  // live on `SessionConfigOption` and the payload interfaces, so each is looked up where the schema
  // puts it rather than read off the wrapper.
  const payloadRequired = (arm?.required ?? []).filter((field) => field !== 'type');
  const carrier = interfaceFields('SessionConfigOption');
  if (!carrier) {
    fail(`${TYPES}: no interface named SessionConfigOption`);
    break;
  }
  for (const field of schemaRequired(defs['SessionConfigOption'])) {
    if (!carrier.required.has(field) && !carrier.optional.has(field)) {
      fail(
        `SessionConfigOption.${field} is required by the schema and absent from the TypeScript — the ` +
          'projection would receive an option with no id to set',
      );
    }
  }
  if (type === 'boolean' && !carrier.required.has('type')) {
    fail('SessionConfigOption.type must be required: the projection branches on it and skips what it cannot read');
  }
  // The select payload has its own def (`SessionConfigSelect`); the boolean arm inlines
  // `currentValue: boolean` on the arm itself, so there is nothing to resolve for it.
  if (type === 'select') {
    const selectFields = interfaceFields('SessionConfigSelect');
    if (!selectFields) {
      fail(`${TYPES}: no interface named SessionConfigSelect — the select payload would be unchecked`);
    } else {
      for (const field of schemaRequired(defs['SessionConfigSelect'])) {
        if (!selectFields.required.has(field) && !selectFields.optional.has(field)) {
          fail(
            `SessionConfigSelect.${field} is required by the schema and absent from the TypeScript — a ` +
              'select option would reach the projection without the values it is supposed to offer',
          );
        }
      }
    }
  }
  for (const field of payloadRequired) {
    if (!carrier.required.has(field) && !carrier.optional.has(field)) {
      fail(
        `the "${type}" arm of SessionConfigOption requires ${field}, and the TypeScript has no such ` +
          'field — the projection cannot see the payload it is meant to validate',
      );
    }
  }
}

// Categories: both directions, because a name kurier invents and a name the schema drops are both
// drift, and only the second is visible by reading the schema.
const schemaCategories = (defs['SessionConfigOptionCategory']?.anyOf ?? [])
  .map((entry) => entry?.const)
  .filter((value) => typeof value === 'string');
for (const category of KNOWN_CONFIG_CATEGORIES) {
  if (!schemaCategories.includes(category)) {
    fail(
      `KNOWN_CONFIG_CATEGORIES names "${category}", which the schema does not define — the surface ` +
        'would order by a category no agent ever sends',
    );
  }
}
for (const category of schemaCategories) {
  if (!KNOWN_CONFIG_CATEGORIES.includes(category)) {
    fail(
      `the schema defines the config category "${category}" and KNOWN_CONFIG_CATEGORIES omits it — it ` +
        'would be treated as unknown and sorted to the end',
    );
  }
}
notes.push(`${KNOWN_CONFIG_CATEGORIES.length} config categories, ${schemaCategories.length} in the schema`);

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
