/**
 * Which providers a person can log in to from lotse, read off opencode's own catalog.
 *
 * **The catalog is the agent's, the policy is lotse's.** opencode v2 lists every integration it knows
 * (`GET /api/integration`, 229 on 2.0.22) with the ways to connect each: an API key, an environment
 * variable, or an OAuth flow. lotse offers the browser logins and the API key; the environment method is
 * left out. An OAuth flow never passes through here: opencode runs it, shows lotse a URL and a code, and
 * keeps the result in its own store. A pasted key is handed to opencode in one call and held nowhere else
 * (`AGENTS.md` § Privacy: memory only, never persisted).
 *
 * `packages/core/data/login-providers.json` is the one list lotse owns: providers it deliberately does not offer
 * (`excluded`, each with its reason), the featured order (`preferred`) and the European ones (`europe`). A
 * provider that is in none is still shown, after the featured ones — a new provider upstream is a row, not a code
 * change, and the file is only touched to *remove* or *reorder*.
 *
 * Pure: no process, no network. The shape parsed here was measured against opencode 2.0.22.
 */

import raw from '../../data/login-providers.json' with { type: 'json' };

export interface LoginFieldOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** `when` on a form field: shown only while another answer equals `value`. Only `eq` exists on the wire. */
export interface LoginFieldCondition {
  readonly key: string;
  readonly value: string;
}

/** One question a method asks before it can start (a GitHub Enterprise host, a Snowflake account). */
export interface LoginField {
  readonly key: string;
  readonly title: string;
  readonly required: boolean;
  /** Never asked: the default is sent as it is (OpenCode Console's server URL). */
  readonly hidden: boolean;
  readonly placeholder?: string;
  readonly default?: string;
  readonly options?: readonly LoginFieldOption[];
  readonly when?: readonly LoginFieldCondition[];
}

export interface LoginMethod {
  readonly id: string;
  /** `oauth`: a browser login opencode runs. `key`: an API key the person pastes, which opencode stores. */
  readonly kind: 'oauth' | 'key';
  readonly label: string;
  readonly fields: readonly LoginField[];
}

export interface LoginProvider {
  readonly id: string;
  readonly name: string;
  /** opencode already holds a connection for it. */
  readonly connected: boolean;
  /** Listed first: opencode's own popular providers and the European ones (`login-providers.json`). */
  readonly featured: boolean;
  /** A provider based in Europe, said on its row. */
  readonly europe: boolean;
  readonly methods: readonly LoginMethod[];
}

export interface LoginPolicy {
  /** Provider id → why lotse does not offer it. */
  readonly excluded: ReadonlyMap<string, string>;
  readonly preferred: readonly string[];
  readonly europe: ReadonlySet<string>;
}

function fail(message: string): never {
  throw new Error(`login providers: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Validate the data file. Throws, because a malformed policy file is a build mistake, not a runtime case. */
export function parseLoginPolicy(value: unknown): LoginPolicy {
  if (!isRecord(value)) fail('the data file is not an object');
  const excluded = new Map<string, string>();
  if (!Array.isArray(value['excluded'])) fail('`excluded` is not a list');
  for (const entry of value['excluded']) {
    const id = isRecord(entry) ? text(entry['id']) : undefined;
    const reason = isRecord(entry) ? text(entry['reason']) : undefined;
    if (!id || !reason) fail('an `excluded` entry needs an id and a reason');
    excluded.set(id, reason);
  }
  if (!Array.isArray(value['preferred']) || !value['preferred'].every((id) => typeof id === 'string')) {
    fail('`preferred` is not a list of ids');
  }
  const europe = value['europe'] === undefined ? [] : value['europe'];
  if (!Array.isArray(europe) || !europe.every((id) => typeof id === 'string')) {
    fail('`europe` is not a list of ids');
  }
  return { excluded, preferred: value['preferred'] as string[], europe: new Set(europe as string[]) };
}

/** The shipped login policy (`data/login-providers.json`): providers lotse hides (with the reason), features first, and marks European. */
export const LOGIN_POLICY: LoginPolicy = parseLoginPolicy(raw);

function parseField(value: unknown): LoginField | null {
  if (!isRecord(value)) return null;
  const key = text(value['key']);
  const title = text(value['title']);
  // Only text answers exist for the providers lotse offers; a number or a multiselect is a field this
  // window has no widget for, so the whole method is left out rather than offered half-working.
  if (!key || value['type'] !== 'string') return null;
  const options = Array.isArray(value['options'])
    ? value['options'].flatMap((option): LoginFieldOption[] => {
        const optionValue = isRecord(option) ? text(option['value']) : undefined;
        if (!isRecord(option) || optionValue === undefined) return [];
        const description = text(option['description']);
        return [
          {
            value: optionValue,
            label: text(option['label']) ?? optionValue,
            ...(description ? { description } : {}),
          },
        ];
      })
    : undefined;
  let when: LoginFieldCondition[] | undefined;
  if (Array.isArray(value['when'])) {
    when = [];
    for (const condition of value['when']) {
      const conditionKey = isRecord(condition) ? text(condition['key']) : undefined;
      const conditionValue = isRecord(condition) ? text(condition['value']) : undefined;
      if (!isRecord(condition) || condition['op'] !== 'eq' || !conditionKey || conditionValue === undefined) {
        return null;
      }
      when.push({ key: conditionKey, value: conditionValue });
    }
  }
  const placeholder = text(value['placeholder']);
  const fallback = text(value['default']);
  return {
    key,
    title: title ?? key,
    required: value['required'] === true,
    hidden: value['hidden'] === true,
    ...(placeholder ? { placeholder } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(options ? { options } : {}),
    ...(when ? { when } : {}),
  };
}

/** The key method carries no id or label on the wire; lotse gives it the same ones everywhere. */
export const KEY_METHOD_ID = 'key';

function parseMethod(value: unknown): LoginMethod | null {
  if (!isRecord(value)) return null;
  const kind = value['type'];
  if (kind !== 'oauth' && kind !== 'key') return null;
  const id = kind === 'key' ? KEY_METHOD_ID : text(value['id']);
  const label = kind === 'key' ? 'API key' : text(value['label']);
  if (!id || !label) return null;
  const fields: LoginField[] = [];
  for (const entry of Array.isArray(value['form']) ? value['form'] : []) {
    const field = parseField(entry);
    if (!field) return null;
    fields.push(field);
  }
  return { id, kind, label, fields };
}

/**
 * The providers to offer, from a `GET /api/integration` body.
 *
 * Throws on a body that is not the catalog at all (that is "this is not opencode v2"); leaves out a single
 * provider or method it cannot read, because the other 228 are still worth showing.
 */
export function parseIntegrations(body: unknown, policy: LoginPolicy = LOGIN_POLICY): LoginProvider[] {
  const list = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(list)) fail('the response has no `data` list');
  const providers: LoginProvider[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = text(entry['id']);
    const name = text(entry['name']);
    if (!id || !name || policy.excluded.has(id)) continue;
    const methods = (Array.isArray(entry['methods']) ? entry['methods'] : []).flatMap(
      (method): LoginMethod[] => {
        const parsed = parseMethod(method);
        return parsed ? [parsed] : [];
      },
    );
    if (methods.length === 0) continue;
    providers.push({
      id,
      name,
      connected: Array.isArray(entry['connections']) && entry['connections'].length > 0,
      featured: policy.preferred.includes(id),
      europe: policy.europe.has(id),
      // A browser login before a pasted key: it is the one that needs nothing from a console.
      methods: [...methods].sort((a, b) => Number(a.kind === 'key') - Number(b.kind === 'key')),
    });
  }
  const rank = (id: string): number => {
    const index = policy.preferred.indexOf(id);
    return index < 0 ? policy.preferred.length : index;
  };
  return providers.sort((a, b) => {
    const byRank = rank(a.id) - rank(b.id);
    if (byRank !== 0) return byRank;
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
